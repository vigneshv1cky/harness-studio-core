/**
 * Default one-shot summarization and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, BlockAssembler, CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  ContentBlock, FinishReason, GenerateOptions, LlmCallConfig, Message, RequestMessage, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  /** Shares of the first refused summary request's size that successive resends aim at. */
  readonly overflowShrinkRatios: readonly number[]
  /** Model that writes the summary; resolved from the session when absent. */
  readonly target?: Pick<LlmCallConfig, 'provider' | 'model'>
  /** Largest estimated summary request; absent sends the conversation unchanged. */
  readonly budget?: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? config.target ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const estimate = (message: Message): number => ctx.tokenMeter.estimateMessage(message)
  const instruction: RequestMessage = deepFreeze({
    role: 'user',
    content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
  })
  let budget = config.budget
  let refusedTokens: number | undefined
  let assembler: BlockAssembler
  let options: GenerateOptions
  for (let resends = 0; ; resends += 1) {
    // Window sizes and estimates can be wrong, so a request that cannot be made
    // to fit is sent whole until the provider itself refuses a summary request.
    const request = fitSummarizationInput(input, budget, estimate)
      ?? (refusedTokens === undefined ? fitSummarizationInput(input, undefined, estimate) : undefined)
    if (request === undefined) {
      throw new LlmError(
        `the compaction request cannot be reduced to ${budget} estimated tokens without dropping the whole conversation`,
        CONTEXT_WINDOW_EXCEEDED_CODE,
      )
    }
    assembler = new BlockAssembler()
    options = {
      provider: target.provider,
      model: target.model,
      messages: [...request.messages, instruction],
      toolHistory: agent.session.toolHistory(),
      ...request.tools === undefined ? {} : { tools: [...request.tools] },
      maxTokens: config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error === undefined) break
    // A refused summary request is resent smaller, aiming below its first refused size like the conversation request.
    const ratio = config.overflowShrinkRatios[resends]
    if (!(error instanceof LlmError) || error.code !== CONTEXT_WINDOW_EXCEEDED_CODE || ratio === undefined) throw error
    signal?.throwIfAborted()
    refusedTokens ??= request.estimatedTokens + estimate(createUserMessage({ content: instruction.content, source: { kind: 'user' } }))
    budget = Math.floor(refusedTokens * ratio)
  }

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/** Framing of a conversation sent as one transcript because it does not fit the summary request budget. */
const TRANSCRIPT_PREAMBLE = 'The conversation so far, as a transcript; the oldest part is omitted when the transcript would not fit:'

/** Marks an entry cut to fit the summary request budget. */
const CUT_MARKER = '\n[… cut to fit …]\n'

/** A summarization request without the trailing instruction, plus its estimated size. */
interface FittedInput {
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly RequestMessage[]
  readonly estimatedTokens: number
}

/**
 * Fit the summarized conversation into `budget` estimated tokens, the
 * instruction included. A conversation that fits is sent unchanged, reusing
 * the provider's cached prefix. Otherwise it is sent without tool schemas as
 * one transcript message after the system prompt: a prior checkpoint stays in
 * front within half the room, the newest entries fill the rest, older entries
 * are dropped, and an entry larger than the remaining room keeps its start
 * and end.
 * @param input - replayed conversation prefix.
 * @param budget - largest estimated request, or `undefined` for no limit.
 * @param estimate - the token meter's per-message estimate.
 * @returns the messages and tools to send and their estimated size, or `undefined` when not even part of one entry fits.
 */
export function fitSummarizationInput(
  input: SummarizationInput,
  budget: number | undefined,
  estimate: (message: Message) => number,
): FittedInput | undefined {
  const estimateText = (text: string): number => estimate(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  const instructionTokens = estimateText(COMPACTION_INSTRUCTION)
  const toolsTokens = input.tools === undefined ? 0 : estimateText(JSON.stringify(input.tools))
  const whole = input.messages.reduce((total, message) => total + estimate(message), toolsTokens)
  if (budget === undefined || whole + instructionTokens <= budget) return { ...input, estimatedTokens: whole }

  const head = input.messages[0]?.role === 'system' ? input.messages[0] : undefined
  const entries = input.messages.slice(head === undefined ? 0 : 1).map(transcriptEntry).filter(entry => entry.length > 0)
  const checkpoint = entries[0]?.includes(SUMMARY_OPEN_TAG) === true ? entries.shift() : undefined
  let room = budget - (head === undefined ? 0 : estimate(head)) - estimateText(TRANSCRIPT_PREAMBLE) - instructionTokens
  const fit = (entry: string, limit: number): string | undefined => {
    const tokens = estimateText(entry)
    const kept = tokens <= limit ? entry : cutToFit(entry, limit, estimateText)
    if (kept !== undefined) room -= kept === entry ? tokens : estimateText(kept)
    return kept
  }
  const front = checkpoint === undefined ? undefined : fit(checkpoint, Math.floor(room / 2))
  const newest: string[] = []
  for (let index = entries.length - 1; index >= 0 && room > 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is within entries
    const kept = fit(entries[index]!, room)
    if (kept === undefined) break
    newest.unshift(kept)
    if (kept !== entries[index]) break
  }
  const kept = front === undefined ? newest : [front, ...newest]
  if (kept.length === 0) return undefined
  const text = [TRANSCRIPT_PREAMBLE, ...kept].join('\n\n')
  const transcript: RequestMessage = { role: 'user', content: [{ type: 'text', text }] }
  return {
    messages: head === undefined ? [transcript] : [head, transcript],
    estimatedTokens: (head === undefined ? 0 : estimate(head)) + estimateText(text),
  }
}

/** Render one replayed message as transcript text; reasoning is left out and images become a placeholder. */
function transcriptEntry(message: Message): string {
  const parts = message.content.flatMap((block): string[] => {
    switch (block.type) {
      case 'text': return block.text.length === 0 ? [] : [block.text]
      case 'tool-call': return [`[tool call ${block.name}: ${block.arguments}]`]
      case 'image': return ['[image]']
      default: return []
    }
  })
  if (parts.length === 0) return ''
  const label = message.role === 'tool' ? 'Tool result' : message.role === 'assistant' ? 'Assistant' : 'User'
  return `${label}: ${parts.join('\n')}`
}

/** Keep the start and end of `entry` within `room` estimated tokens, or `undefined` when no part fits. */
function cutToFit(entry: string, room: number, estimateText: (text: string) => number): string | undefined {
  for (let length = Math.floor(entry.length / 2); length > 0; length = Math.floor(length / 2)) {
    const start = Math.ceil(length / 2)
    const cut = `${entry.slice(0, start)}${CUT_MARKER}${entry.slice(entry.length - (length - start))}`
    if (estimateText(cut) <= room) return cut
  }
  return undefined
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
