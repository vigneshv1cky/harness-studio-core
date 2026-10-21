/** Map system snapshots, tool changes, and conversation turns to Messages using the configured route capability. */

import { LlmError, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { DeepSeekConnectionOptions as Connection } from './types.ts'
import type { DeepSeekFileId } from './file-id.ts'
import { readReplay } from './replay.ts'
import type { WireBlock, WireInput, WireMessage, WireRequest } from './wire-types.ts'

function unsupported(type: string): never {
  throw new LlmError(`DeepSeek Messages cannot represent ${type}`, 'UNSUPPORTED_CONTENT')
}

/** Historical arguments that Messages cannot represent use empty input; durable content stays unchanged. */
function toolInput(raw: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(raw) } catch (_invalidToolHistoryJson) {
    return {}
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Text the multi-provider adapter stores for a redacted (encrypted) Anthropic
 * thinking block. The readable text is a placeholder and the encrypted payload
 * is replayable only to the model that produced it, so another model is sent nothing.
 */
const REDACTED_REASONING_PLACEHOLDER = '[Reasoning redacted]'

function assistant(message: Message, model: string, onReplayDegrade?: (reason: string) => void): WireBlock[] {
  const replay = readReplay(message, model, onReplayDegrade)
  return message.content.flatMap((block, index): WireBlock | WireBlock[] => {
    switch (block.type) {
      case 'text': return block.text.length === 0 ? [] : { type: 'text', text: block.text }
      case 'reasoning': {
        const signature = replay?.[index]?.signature
        // Unsigned reasoning from another model is sent only when it is readable text.
        if (signature === undefined && (block.text.trim().length === 0 || block.text === REDACTED_REASONING_PLACEHOLDER)) return []
        return { type: 'thinking', thinking: block.text, ...signature === undefined ? {} : { signature } }
      }
      case 'tool-call': return { type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) }
      default: return unsupported(`assistant content ${block.type}`)
    }
  })
}

/**
 * Omit thinking from assistant messages before the current turn, which starts
 * at the last user message without a tool result; a thinking-only message
 * keeps its thinking so no message disappears.
 */
function omitEarlierThinking(messages: WireMessage[]): void {
  const start = messages.findLastIndex(message => message.role === 'user' && !message.content.some(block => block.type === 'tool_result'))
  for (const message of messages.slice(0, Math.max(start, 0))) {
    if (message.role !== 'assistant') continue
    const kept = message.content.filter(block => block.type !== 'thinking')
    if (kept.length > 0) message.content = kept
  }
}

/** Tool-call id length the Messages protocol accepts. */
const MAX_TOOL_ID_LENGTH = 64

/** Result sent for a call whose result is not in the history, such as one interrupted before it ran. */
const MISSING_RESULT_TEXT = 'No result was recorded for this tool call.'

/** Text placed before a result whose call is not in the history, so its content stays visible. */
const ORPHAN_RESULT_TEXT = 'Result of an earlier tool call that is no longer in this conversation:'

/**
 * Map a history tool-call id to one the Messages protocol accepts: letters,
 * digits, underscore and hyphen, at most 64 characters, unique within the
 * request. Other providers' ids (for example OpenAI Responses' `call|item`
 * pairs) contain other characters. Equal input history yields equal ids, so a
 * cached request prefix keeps matching.
 */
function wireToolId(id: string, used: Set<string>): string {
  const base = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_TOOL_ID_LENGTH) || 'tool'
  let candidate = base
  for (let suffix = 1; used.has(candidate); suffix += 1) {
    const tail = `_${suffix}`
    candidate = `${base.slice(0, MAX_TOOL_ID_LENGTH - tail.length)}${tail}`
  }
  used.add(candidate)
  return candidate
}

/**
 * Pair every tool call with a result in the user turn that follows it, as the
 * Messages protocol requires, repairing history another provider produced or
 * an interruption left incomplete instead of refusing the request. Ids are
 * rewritten by {@link wireToolId}; a call without a result gets an error
 * result saying none was recorded; a result without a call becomes ordinary
 * user content; results move to the start of their user turn.
 * @param messages - wire conversation, rewritten in place.
 */
function pairToolHistory(messages: WireMessage[]): void {
  const used = new Set<string>()
  // Calls awaiting a result, in call order; a repeated history id pairs with its earliest unanswered call.
  let pending: Array<{ history: string; wire: string }> = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      pending = []
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue
        const wire = wireToolId(block.id, used)
        pending.push({ history: block.id, wire })
        block.id = wire
      }
      // A user turn is required after calls; insert one when the next turn is not a user turn.
      if (pending.length > 0 && messages[index + 1]?.role !== 'user') {
        messages.splice(index + 1, 0, { role: 'user', content: [] })
      }
    } else if (message.role === 'user') {
      const results: WireBlock[] = []
      const rest: WireBlock[] = []
      for (const block of message.content) {
        if (block.type !== 'tool_result') {
          rest.push(block)
          continue
        }
        const call = pending.findIndex(entry => entry.history === block.tool_use_id)
        if (call === -1) {
          rest.push({ type: 'text', text: ORPHAN_RESULT_TEXT }, ...block.content)
          continue
        }
        // oxlint-disable-next-line typescript/no-non-null-assertion -- findIndex returned an existing index
        results.push({ ...block, tool_use_id: pending.splice(call, 1)[0]!.wire })
      }
      const missing = pending.map((entry): WireBlock => ({
        type: 'tool_result', tool_use_id: entry.wire, content: [{ type: 'text', text: MISSING_RESULT_TEXT }], is_error: true,
      }))
      message.content = [...results, ...missing, ...rest]
      pending = []
    }
  }
}

/** Serialize one complete request using already prepared image bytes.
 * User and tool-result content omits reasoning and tool-call blocks.
 * Empty assistant text blocks and empty user/assistant messages are skipped;
 * empty tool results retain their call ids. Unsigned reasoning is sent only as
 * readable text; tool history is repaired by `pairToolHistory`.
 * Routes declaring `reasoningHistory: 'current-turn'` omit thinking before the current turn.
 * Developer messages, already projected for this route by `LlmRuntime`, become
 * system-role updates after the preceding user turn, with tool changes as
 * `tool_addition` and `tool_removal` references to the declared tool.
 * @param options - provider-neutral request.
 * @param connection - validated defaults and thinking policy.
 * @param history - image-projected history with complete system snapshots; durable messages remain unchanged.
 * @param images - request versions for retained images.
 * @param access - execution-world paths for image descriptions.
 * @param onReplayDegrade - diagnostic for discarded native replay metadata.
 * @param fileIds - resolved Files references; omission selects inline image bytes.
 * @returns the Messages API JSON body.
 */
export function serialize(
  options: GenerateOptions, connection: Connection, history: readonly RequestMessage[],
  images: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>, access: ImageAttachmentAccessResolver,
  onReplayDegrade?: (reason: string) => void,
  fileIds?: ReadonlyMap<ImageAttachmentRef['attachmentId'], DeepSeekFileId>,
): WireRequest {
  const model = connection.models.find(entry => entry.id === options.model)
  const inHistory = model?.systemPromptUpdate === 'in-history'
  const input = (blocks: readonly ContentBlock[]): WireInput[] => blocks.flatMap((block): WireInput[] => {
    if (block.type === 'text') return block.text ? [{ type: 'text', text: block.text }] : []
    if (block.type === 'reasoning' || block.type === 'tool-call') return []
    if (block.type !== 'image') return unsupported(`user/tool-result content ${block.type}`)
    const version = images.get(block.attachment.attachmentId)
    if (version === undefined) throw new LlmError('DeepSeek Messages request image is missing', 'INVALID_REQUEST')
    const fileId = fileIds?.get(block.attachment.attachmentId)
    if (fileIds !== undefined && fileId === undefined) throw new LlmError('DeepSeek Messages request file id is missing', 'INVALID_REQUEST')
    return [
      { type: 'text', text: requestImageHandleText(block.attachment, version, access(block.attachment)) },
      fileId === undefined
        ? { type: 'image', source: { type: 'base64', media_type: version.mediaType, data: Buffer.from(version.data).toString('base64') } }
        : { type: 'image', source: { type: 'file', file_id: fileId } },
    ]
  })
  const messages: WireMessage[] = []
  let historySystem: string | undefined
  const systemUpdates: WireMessage[] = []
  // Harness admits system updates before user input. Messages places the same
  // update after that user/tool-result turn and before the next assistant.
  const flushSystemUpdates = () => {
    if (systemUpdates.length === 0) return
    if (messages.at(-1)?.role !== 'user') return unsupported('system update without a preceding user or tool-result turn')
    messages.push(...systemUpdates.splice(0))
  }
  for (const message of history) {
    if (message.role === 'developer') {
      const content = message.content.flatMap((block): WireBlock[] => {
        switch (block.type) {
          case 'text': return block.text.length === 0 ? [] : [{ type: 'text', text: block.text }]
          case 'tool-addition': return [{ type: 'tool_addition', tool: { type: 'tool_reference', name: block.toolName } }]
          case 'tool-removal': return [{ type: 'tool_removal', tool: { type: 'tool_reference', name: block.toolName } }]
          default: return unsupported(`developer content ${block.type}`)
        }
      })
      if (content.length > 0) systemUpdates.push({ role: 'system', content })
      continue
    }
    if (message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      return unsupported('tool-change blocks outside developer messages')
    }
    if (message.role === 'system') {
      const texts = message.content.filter(block => block.type === 'text')
      if (texts.length !== message.content.length) return unsupported('non-text system message')
      const text = texts.map(block => block.text).join('')
      if (inHistory && messages.length > 0) {
        if (text.length === 0) return unsupported('empty in-history system update')
        systemUpdates.push({ role: 'system', content: [{ type: 'text', text }] })
      } else {
        historySystem = text
      }
      continue
    }
    const content: WireBlock[] = message.role === 'assistant'
      ? assistant(message, options.model, onReplayDegrade)
      : message.role === 'tool'
        ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: input(message.content), ...message.isError === undefined ? {} : { is_error: message.isError } }]
        : message.content.flatMap((block): WireBlock[] => input([block]))
    if ((message.role === 'user' || message.role === 'assistant') && content.length === 0) continue
    if (message.role === 'assistant') flushSystemUpdates()
    const wireRole = message.role === 'tool' ? 'user' : message.role
    const previous = messages.at(-1)
    if (previous?.role === wireRole) previous.content.push(...content)
    else messages.push({ role: wireRole, content })
  }
  flushSystemUpdates()
  if (model?.reasoningHistory === 'current-turn') omitEarlierThinking(messages)
  pairToolHistory(messages)
  const effort = options.reasoningEffort ?? (connection.defaults.reasoningEffort ?? (connection.defaults.thinking === 'disabled' ? 'off' : 'high'))
  if (!['off', 'low', 'high', 'max'].includes(effort) || (connection.defaults.thinking === 'disabled' && effort !== 'off')) {
    throw new LlmError(`DeepSeek Messages does not support reasoning effort ${effort}`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  const system = [options.system, historySystem].filter(Boolean).join('\n\n')
  return {
    model: options.model, stream: true, messages,
    max_tokens: options.maxTokens ?? model?.maxTokens ?? connection.maxTokens,
    thinking: { type: effort === 'off' ? 'disabled' : 'enabled' },
    ...effort === 'off' ? {} : { output_config: { effort: effort as 'low' | 'high' | 'max' } },
    ...system.length === 0 ? {} : { system },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop_sequences: options.stop },
    ...options.tools === undefined ? {} : {
      tools: options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        ...tool.deferLoading === true ? { defer_loading: true as const } : {},
      })),
    },
  }
}
