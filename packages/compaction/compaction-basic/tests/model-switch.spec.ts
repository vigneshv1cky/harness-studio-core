import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { resolveConfig, resolveTargetPolicy } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { fitSummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import LlmRuntime, {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, Message, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/src/estimate.ts'

const SIGNAL = new AbortController().signal

/** The compaction instruction marks a summary request; everything else is a conversation request. */
function isSummaryRequest(options: GenerateOptions): boolean {
  const last = options.messages.at(-1)
  return last?.content.some(block => block.type === 'text' && block.text.includes('acting as a compaction engine')) === true
}

/** Heuristic size of one request, priced like the token meter prices a request. */
function requestTokens(options: GenerateOptions): number {
  const messages = options.messages.map((message): Message => (
    message.source === undefined ? createUserMessage({ content: message.content, source: { kind: 'user' } }) : message
  ))
  const tools = options.tools === undefined
    ? 0
    : estimateMessage(createUserMessage({ content: [{ type: 'text', text: JSON.stringify(options.tools) }], source: { kind: 'user' } }))
  return messages.reduce((total, message) => total + estimateMessage(message), tools)
}

/**
 * One adapter for every route, with a per-provider window. `refuse` decides
 * which conversation requests the provider refuses as too long; summary
 * requests answer with the next scripted summary, or are refused while
 * `refuseSummaries` is positive.
 */
class RoutedAdapter extends LlmAdapter {
  readonly conversations: GenerateOptions[] = []
  readonly summaries: GenerateOptions[] = []
  refuse: (attempt: number) => boolean = () => false
  refuseSummaries = 0
  summaryTexts: string[] = []
  usage: TokenUsage | undefined

  constructor(private readonly windows: Readonly<Record<string, number>>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const contextWindow = this.windows[provider]
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (isSummaryRequest(options)) {
      this.summaries.push(options)
      if (this.refuseSummaries > 0) {
        this.refuseSummaries -= 1
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'prompt is too long', code: CONTEXT_WINDOW_EXCEEDED_CODE } } }
        return
      }
      const text = this.summaryTexts.shift() ?? 'checkpoint'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.conversations.push(options)
    if (this.refuse(this.conversations.length)) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'prompt is too long', code: CONTEXT_WINDOW_EXCEEDED_CODE } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    if (this.usage !== undefined) yield { type: 'usage', usage: this.usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface LoopHarness {
  readonly ctx: Context
  readonly agent: Agent
  readonly adapter: RoutedAdapter
  readonly selection: ModelSelectionRef
}

async function loopHarness(
  windows: Readonly<Record<string, number>>,
  config: BasicCompactionConfig,
): Promise<LoopHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new RoutedAdapter(windows)
  ctx.llm.registerAdapter(Object.keys(windows), adapter)
  await ctx.plugin(BasicCompactionEngine, config)
  const first = Object.keys(windows)[0]!
  const agent = await ctx.agentLoop.create(SessionId(`switch-${first}`), { provider: first, model: first })
  const selection: ModelSelectionRef = { current: { provider: first, model: first }, assembled: undefined }
  installModelSelection(agent.ctx, selection)
  return { ctx, agent, adapter, selection }
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

const summaryEvents = (agent: Agent) => agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')

describe('compaction after a model switch', () => {
  it('measures the selected model\'s window and lets it write the summary before its first request', async () => {
    const { ctx, agent, adapter, selection } = await loopHarness(
      { large: 1_000_000, small: 2_000 },
      { headroomTokens: 0, maxTokens: 400, retainTokens: 100 },
    )
    try {
      await send(agent, `first question ${'history '.repeat(1_500)}`)
      await send(agent, `second question ${'recent '.repeat(100)}`)
      expect(summaryEvents(agent)).toHaveLength(0)

      selection.current = { provider: 'small', model: 'small' }
      await send(agent, 'continue on the small model')

      const [summary] = summaryEvents(agent)
      expect(summary?.data).toMatchObject({ provider: 'small', model: 'small' })
      expect(adapter.summaries.map(options => options.provider)).toEqual(['small'])
      // The summary request leaves the summary cap free in the small window.
      expect(requestTokens(adapter.summaries[0]!)).toBeLessThanOrEqual(2_000 - 400)
      const smallRequest = adapter.conversations.at(-1)!
      expect(smallRequest.provider).toBe('small')
      expect(JSON.stringify(smallRequest.messages)).toContain('<compacted-summary>')
      expect(JSON.stringify(smallRequest.messages)).not.toContain('history history history')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not reuse the previous provider\'s token count for the selected model', async () => {
    const { ctx, agent, adapter, selection } = await loopHarness(
      { large: 1_000_000, small: 60_000 },
      { headroomTokens: 0, maxTokens: 400 },
    )
    try {
      // The previous provider reports far more than the surface holds; the selected model's window would be past threshold by that count.
      adapter.usage = { inputTokens: 55_000, outputTokens: 10 }
      await send(agent, `first question ${'history '.repeat(400)}`)
      adapter.usage = undefined
      selection.current = { provider: 'small', model: 'small' }
      await send(agent, 'continue on the small model')

      expect(summaryEvents(agent)).toHaveLength(0)
      expect(adapter.conversations.at(-1)?.provider).toBe('small')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('compacts an idle session with the pending selection', async () => {
    const { ctx, agent, adapter, selection } = await loopHarness(
      { large: 1_000_000, small: 1_000_000 },
      { auto: false, headroomTokens: 0, maxTokens: 400 },
    )
    try {
      await send(agent, `first question ${'history '.repeat(200)}`)
      await send(agent, 'second question')
      selection.current = { provider: 'small', model: 'small' }
      const compact = ctx.get('compaction')!

      expect(await compact.compactNow(agent, SIGNAL)).not.toBeNull()
      expect(summaryEvents(agent).map(event => event.data.provider)).toEqual(['small'])
      expect(adapter.summaries.map(options => options.provider)).toEqual(['small'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('compact and retry after a too-long refusal', () => {
  const history = (turn: number) => `turn ${turn} ${'context '.repeat(300)}`

  it('aims each retry\'s summary request at 70%, 50%, then 35% of the first refused size, then fails the turn', async () => {
    const { ctx, agent, adapter } = await loopHarness(
      { provider: 1_000_000 },
      { headroomTokens: 0, maxTokens: 400 },
    )
    try {
      for (let turn = 1; turn <= 3; turn += 1) await send(agent, history(turn))
      const refusedFrom = adapter.conversations.length + 1
      adapter.refuse = attempt => attempt >= refusedFrom
      adapter.summaryTexts = ['long checkpoint '.repeat(200), 'medium checkpoint '.repeat(60), 'short']
      const refused = ctx.tokenMeter.measure(agent.session).totalTokens + 10
      await send(agent, 'one more question')

      expect(adapter.conversations).toHaveLength(refusedFrom + 3)
      expect(adapter.summaries).toHaveLength(3)
      const sizes = adapter.summaries.map(requestTokens)
      expect(sizes[0]).toBeLessThanOrEqual(Math.floor(refused * 0.7))
      expect(sizes[1]).toBeLessThanOrEqual(Math.floor(refused * 0.5))
      expect(sizes[2]).toBeLessThanOrEqual(Math.floor(refused * 0.35))
      // A shrunk summary request carries the conversation as one transcript, newest part kept.
      expect(adapter.summaries[0]!.tools).toBeUndefined()
      const transcript = JSON.stringify(adapter.summaries[0]!.messages)
      expect(transcript).toContain('turn 3')
      expect(transcript).not.toContain('turn 1')
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { code: CONTEXT_WINDOW_EXCEEDED_CODE } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('completes the turn once a retried request is accepted and starts a fresh sequence after it', async () => {
    const { ctx, agent, adapter } = await loopHarness(
      { provider: 1_000_000 },
      { headroomTokens: 0, maxTokens: 400 },
    )
    try {
      for (let turn = 1; turn <= 3; turn += 1) await send(agent, history(turn))
      const refusedAt = adapter.conversations.length + 1
      adapter.refuse = attempt => attempt === refusedAt
      await send(agent, 'one more question')

      expect(adapter.conversations).toHaveLength(refusedAt + 1)
      expect(JSON.stringify(adapter.conversations.at(-1)!.messages)).toContain('<compacted-summary>')
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

class ExposedEngine extends BasicCompactionEngine {
  run(input: SummarizationInput, owner: Agent) {
    return this.summarize(input, owner, SIGNAL)
  }
}

describe('summary request size', () => {
  async function summarizer(windows: Readonly<Record<string, number>>, config: BasicCompactionConfig = { auto: false, maxTokens: 400 }) {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    void new TokenMeter(ctx)
    const adapter = new RoutedAdapter(windows)
    ctx.llm.registerAdapter(Object.keys(windows), adapter)
    return { ctx, adapter, engine: new ExposedEngine(ctx, config) }
  }

  function routed(provider: string): Agent {
    const session = Session.create(SessionId(`summary-${provider}`))
    session.append('request/header', { header: { config: { provider, model: provider } }, reason: 'initial' })
    return { session, options: {} } as Agent
  }

  const input = (turns: number): SummarizationInput => ({
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    messages: [
      createSystemMessage('system prompt'),
      ...Array.from({ length: turns }, (_, turn) => createUserMessage({
        content: [{ type: 'text', text: `turn ${turn} ${'words '.repeat(200)}` }],
        source: { kind: 'user' },
      })),
    ],
  })

  it('resends a refused summary request smaller and fails after the shrink steps', async () => {
    const { adapter, engine } = await summarizer({ provider: 1_000_000 })
    adapter.refuseSummaries = 1
    const output = await engine.run(input(12), routed('provider'))

    expect(output.summary).toEqual([{ type: 'text', text: 'checkpoint' }])
    const [first, second] = adapter.summaries.map(requestTokens)
    expect(second).toBeLessThanOrEqual(Math.floor(first! * 0.7))

    adapter.refuseSummaries = 4
    adapter.summaries.length = 0
    await expect(engine.run(input(12), routed('provider'))).rejects.toMatchObject({ code: CONTEXT_WINDOW_EXCEEDED_CODE })
    expect(adapter.summaries).toHaveLength(4)
  })

  it('fits the summary request into the summarizing model\'s window minus the summary cap', async () => {
    const { adapter, engine } = await summarizer({ provider: 2_400 })
    await engine.run(input(12), routed('provider'))
    expect(requestTokens(adapter.summaries[0]!)).toBeLessThanOrEqual(2_000)
  })

  it('fails a refused summary request that cannot be made smaller', async () => {
    const { adapter, engine } = await summarizer({ provider: 1_000_000 })
    adapter.refuseSummaries = 1
    const tiny: SummarizationInput = { messages: [createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })] }
    await expect(engine.run(tiny, routed('provider'))).rejects.toThrow(/cannot be reduced/)
    expect(adapter.summaries).toHaveLength(1)
  })

  it('limits the summary request only by refusals when the route has no model metadata', async () => {
    const { ctx, adapter, engine } = await summarizer({ provider: 1_000_000 })
    ctx.llm.resolveModelInfo = () => Promise.reject(new Error('no metadata'))
    await engine.run(input(12), routed('provider'))
    expect(adapter.summaries[0]?.tools).toBeDefined()
  })

  it('reads the route a model selection reports', async () => {
    const { ctx, adapter, engine } = await summarizer({ provider: 1_000_000, selected: 1_000_000 })
    ctx.on('agent/model-selection', async (_payload, next) => (await next()) ?? { provider: 'selected', model: 'selected' })
    expect((await engine.run(input(1), routed('provider'))).provider).toBe('selected')
    expect(adapter.summaries[0]?.provider).toBe('selected')
  })
})

describe('overflow shrink configuration', () => {
  it('validates shrink ratios and their count, and inherits an empty list', () => {
    expect(() => resolveConfig({ overflowShrinkRatios: [0.5, 0.7] })).toThrow(/strictly decreasing/)
    expect(() => resolveConfig({ overflowShrinkRatios: [1] })).toThrow(/strictly decreasing/)
    expect(() => resolveConfig({ overflowShrinkRatios: 'x' as never })).toThrow(/strictly decreasing/)
    expect(() => resolveConfig({ maxOverflowRetries: 4 })).toThrow(/exceeds the 3 overflowShrinkRatios entries/)
    expect(() => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', overflowShrinkRatios: [0.5] }] }))
      .toThrow(/modelPolicies\[0\]: maxOverflowRetries \(3\) exceeds/)
    const config = resolveConfig({
      overflowShrinkRatios: [],
      modelPolicies: [{ provider: 'p', model: 'm', maxOverflowRetries: 1, overflowShrinkRatios: [0.4] }, { provider: 'q', model: 'q', overflowShrinkRatios: [] }],
    })
    expect(config.overflowShrinkRatios).toEqual([0.7, 0.5, 0.35])
    expect(resolveTargetPolicy(config, { provider: 'p', model: 'm' }).overflowShrinkRatios).toEqual([0.4])
    expect(resolveTargetPolicy(config, { provider: 'q', model: 'q' }).overflowShrinkRatios).toEqual([0.7, 0.5, 0.35])
  })
})

describe('fitSummarizationInput', () => {
  const estimate = (message: Message) => estimateMessage(message)
  const text = (message: RequestMessage | undefined) => message?.content.map(block => block.type === 'text' ? block.text : '').join('') ?? ''
  const user = (value: string) => createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })

  it('sends a conversation that fits unchanged, tools included', () => {
    const input: SummarizationInput = { tools: [{ name: 'read', description: 'd', parameters: {} }], messages: [user('short')] }
    const fitted = fitSummarizationInput(input, 100_000, estimate)
    expect(fitted?.messages).toBe(input.messages)
    expect(fitted?.tools).toBe(input.tools)
    expect(fitSummarizationInput(input, undefined, estimate)?.messages).toBe(input.messages)
  })

  it('keeps the system prompt, a prior checkpoint and the newest entries as one transcript', () => {
    const call = ToolCallId('c1')
    const input: SummarizationInput = {
      tools: [{ name: 'read', description: 'd', parameters: {} }],
      messages: [
        createSystemMessage('system prompt'),
        user('<compacted-summary>prior checkpoint</compacted-summary>'),
        user(`OLDEST ${'old '.repeat(400)}`),
        user(`OLDER ${'older '.repeat(400)}`),
        createAssistantMessage({
          content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'reading' }, { type: 'tool-call', id: call, name: 'read', arguments: '{"path":"a"}' }],
          source: { provider: 'p', model: 'm' },
        }),
        createToolResultMessage({ callId: call, content: [{ type: 'text', text: 'file body' }], isError: false }),
        user('NEWEST question'),
      ],
    }
    const fitted = fitSummarizationInput(input, 900, estimate)!
    expect(fitted.tools).toBeUndefined()
    expect(fitted.messages[0]).toBe(input.messages[0])
    const transcript = text(fitted.messages[1])
    expect(transcript).toContain('prior checkpoint')
    expect(transcript).toContain('Assistant: reading\n[tool call read: {"path":"a"}]')
    expect(transcript).toContain('Tool result: file body')
    expect(transcript).toContain('NEWEST question')
    expect(transcript).toContain('OLDER older')
    expect(transcript).toContain('[… cut to fit …]')
    expect(transcript).not.toContain('OLDEST')
    expect(transcript).not.toContain('hidden')
    expect(fitted.estimatedTokens).toBeLessThanOrEqual(900)
  })

  it('cuts an entry larger than the room to its start and end, and gives up when nothing fits', () => {
    const input: SummarizationInput = { messages: [user(`START ${'middle '.repeat(2_000)} END`)] }
    const fitted = fitSummarizationInput(input, 1_000, estimate)!
    const transcript = text(fitted.messages[0])
    expect(transcript).toContain('START')
    expect(transcript).toContain('END')
    expect(transcript).toContain('[… cut to fit …]')
    expect(fitted.estimatedTokens).toBeLessThanOrEqual(1_000)
    expect(fitSummarizationInput(input, 10, estimate)).toBeUndefined()
    // Budgets between nothing fitting and the first cut that fits yield no request; larger ones always do.
    const fits = Array.from({ length: 700 }, (_, budget) => fitSummarizationInput(input, budget, estimate) !== undefined)
    expect(fits.indexOf(true)).toBeGreaterThan(0)
    expect(fits.slice(fits.indexOf(true)).every(Boolean)).toBe(true)
  })

  it('renders images as a placeholder and leaves out messages with no text', () => {
    const attachment = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    const input: SummarizationInput = { messages: [
      user(`question ${'words '.repeat(400)}`),
      createUserMessage({ content: [{ type: 'image', attachment }, { type: 'text', text: '' }], source: { kind: 'user' } }),
      createAssistantMessage({ content: [{ type: 'reasoning', text: 'hidden' }], source: { provider: 'p', model: 'm' } }),
    ] }
    const transcript = text(fitSummarizationInput(input, 700, estimate)?.messages[0])
    expect(transcript).toContain('User: [image]')
    expect(transcript).not.toContain('Assistant:')
  })
})
