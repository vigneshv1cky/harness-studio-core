/**
 * Harness Studio: the terminal chat's live stream. Reasoning, answer text, tool calls and their results are reported
 * to a view (the line chat's or the full-screen chat's) as they happen. Text from the model or a tool passes through
 * {@link escapeTerminal} first, so it cannot drive the terminal: clear the screen, set the window title, write the
 * clipboard or draw a fake prompt.
 *
 * Streamed text cannot be taken back. When the model request for a step is retried after some of its text was
 * printed, a `(retrying)` line separates the two attempts; the durable Session log stays the authority.
 * @module @deepseek-ai/dsh-headless/chat-stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ChatView } from '@deepseek-ai/dsh-terminal-chat'

/** C0 controls other than tab and newline, DEL, and C1 controls. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/**
 * Make text safe to print to a terminal: every control character except tab and newline becomes a visible `\xNN`.
 * @param text - model or tool text.
 * @returns the text with control characters shown, not interpreted.
 */
export function escapeTerminal(text: string): string {
  return text.replace(CONTROL, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** Argument fields that best say what a tool call does, in order of preference. */
const SUMMARY_FIELDS = ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query'] as const
const SUMMARY_LENGTH = 80

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1)}…` : line
}

/**
 * A short description of a tool call from its JSON arguments.
 * @param raw - the call's arguments as the model wrote them.
 * @returns the first useful argument on one line, or an empty string.
 */
export function toolSummary(raw: string): string {
  let args: unknown
  try {
    args = JSON.parse(raw)
  } catch {
    // Unparsable arguments: the tool name alone describes the call.
    return ''
  }
  if (typeof args !== 'object' || args === null) return ''
  for (const field of SUMMARY_FIELDS) {
    const value: unknown = (args as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value)
  }
  return ''
}

/** One reply's live stream. */
export interface ChatStream {
  /** Whether any answer text was streamed. */
  printed(): boolean
  /** Stop listening. */
  dispose(): void
}

/**
 * Report one reply to a view as it happens. Model and tool text is escaped here, once, for every view.
 * @param ctx - plugin context carrying the live Assistant frames and Session events.
 * @param agent - the chat's Agent; other Agents' output is ignored.
 * @param view - the line chat's or the full-screen chat's view.
 * @param options - `liveText` streams the answer; without it the caller passes the answer when the turn ends
 *   (stdout is not a terminal).
 * @returns the stream's handle.
 */
export function streamChat(ctx: Context, agent: Agent, view: ChatView, options: { liveText: boolean }): ChatStream {
  let printedAny = false
  // The step the current model attempt belongs to, and whether that attempt has shown answer text.
  let attemptStep = ''
  let attemptPrinted = false
  const toolNames = new Map<string, string>()

  const stopFrames = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return
    if (frame.type === 'start') {
      const step = `${String(frame.turn)}:${String(frame.step)}`
      view.attemptStart(attemptPrinted && step === attemptStep)
      attemptStep = step
      attemptPrinted = false
      return
    }
    if (frame.type === 'end') {
      view.attemptEnd()
      return
    }
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'reasoning-delta':
        if (chunk.text !== '') view.reasoning(escapeTerminal(chunk.text))
        return
      case 'text-delta':
        view.blockEnd()
        if (!options.liveText || chunk.text === '') return
        view.answer(escapeTerminal(chunk.text))
        printedAny = true
        attemptPrinted = true
        return
      case 'block-start':
        if (chunk.blockType !== 'reasoning') view.blockEnd()
        return
      case 'block-end':
        if (chunk.block.type !== 'reasoning') view.blockEnd()
        return
      case 'usage':
        return
      case 'tool-call-delta':
      case 'finish':
        view.blockEnd()
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(chunk, 'terminal chat stream')
    }
  })

  const stopEvents = ctx.on('session/event', (session: unknown, event: SessionEvent) => {
    if (session !== agent.session) return
    if (event.type === 'tool/call') {
      toolNames.set(event.data.callId, event.data.name)
      view.toolCall(event.data.callId, escapeTerminal(event.data.name), escapeTerminal(toolSummary(event.data.arguments)))
      return
    }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const message = event.data.message
      const name = escapeTerminal(toolNames.get(message.toolCallId) ?? 'tool')
      if (message.isError !== true) {
        view.toolResult(message.toolCallId, name, undefined)
        return
      }
      const first = message.content
        .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('')
        .split('\n')
        .map(line => line.trim())
        .find(line => line !== '') ?? 'failed'
      view.toolResult(message.toolCallId, name, escapeTerminal(oneLine(first)))
    }
  })

  return {
    printed: () => printedAny,
    dispose(): void {
      stopFrames()
      stopEvents()
    },
  }
}
