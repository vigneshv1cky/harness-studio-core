/**
 * Harness Studio: the terminal chat's live output. The answer streams to stdout as the model writes it, reasoning
 * streams to stderr, and each tool call and each result take one stderr line. Text from the model or a tool passes
 * through {@link escapeTerminal} before it is printed, so it cannot drive the terminal: clear the screen, set the
 * window title, write the clipboard or draw a fake prompt.
 *
 * Streamed text cannot be taken back. When the model request for a step is retried after some of its text was
 * printed, a `(retrying)` line separates the two attempts; the durable Session log stays the authority.
 * @module @deepseek-ai/dsh-headless/chat-stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'

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

/** Where the chat prints. */
export interface ChatSinks {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

/** One reply's live output. */
export interface ChatStream {
  /** Whether any answer text was printed while streaming. */
  printed(): boolean
  /** Stop listening and end any unfinished line. */
  dispose(): void
}

/**
 * Print one reply as it happens.
 * @param ctx - plugin context carrying the live Assistant frames and Session events.
 * @param agent - the chat's Agent; other Agents' output is ignored.
 * @param sinks - stdout for the answer, stderr for reasoning and tool lines.
 * @param options - `liveText` streams the answer; without it only reasoning and tool lines are live, and the caller
 *   prints the answer when the turn ends (stdout is not a terminal).
 * @returns the stream's handle.
 */
export function streamChat(ctx: Context, agent: Agent, sinks: ChatSinks, options: { liveText: boolean }): ChatStream {
  let reasoningOpen = false
  let reasoningEndsLine = true
  let answerEndsLine = true
  let printedAny = false
  // The step the current model attempt belongs to, and whether that attempt has printed answer text.
  let attemptStep = ''
  let attemptPrinted = false
  const toolNames = new Map<string, string>()

  const closeReasoning = (): void => {
    if (!reasoningOpen) return
    if (!reasoningEndsLine) sinks.stderr.write('\n')
    reasoningOpen = false
    reasoningEndsLine = true
  }
  const endAnswerLine = (): void => {
    if (answerEndsLine) return
    sinks.stdout.write('\n')
    answerEndsLine = true
  }

  const stopFrames = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent) return
    if (frame.type === 'start') {
      closeReasoning()
      endAnswerLine()
      const step = `${String(frame.turn)}:${String(frame.step)}`
      if (attemptPrinted && step === attemptStep) sinks.stderr.write('(retrying)\n')
      attemptStep = step
      attemptPrinted = false
      return
    }
    if (frame.type === 'end') {
      closeReasoning()
      endAnswerLine()
      return
    }
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'reasoning-delta':
        if (chunk.text === '') return
        if (!reasoningOpen) {
          endAnswerLine()
          sinks.stderr.write('dsh: reasoning:\n')
          reasoningOpen = true
        }
        sinks.stderr.write(escapeTerminal(chunk.text))
        reasoningEndsLine = chunk.text.endsWith('\n')
        return
      case 'text-delta':
        closeReasoning()
        if (!options.liveText || chunk.text === '') return
        sinks.stdout.write(escapeTerminal(chunk.text))
        answerEndsLine = chunk.text.endsWith('\n')
        printedAny = true
        attemptPrinted = true
        return
      case 'block-start':
        if (chunk.blockType !== 'reasoning') closeReasoning()
        return
      case 'block-end':
        if (chunk.block.type !== 'reasoning') closeReasoning()
        return
      case 'usage':
        return
      case 'tool-call-delta':
      case 'finish':
        closeReasoning()
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(chunk, 'terminal chat stream')
    }
  })

  const stopEvents = ctx.on('session/event', (session: unknown, event: SessionEvent) => {
    if (session !== agent.session) return
    if (event.type === 'tool/call') {
      closeReasoning()
      endAnswerLine()
      toolNames.set(event.data.callId, event.data.name)
      const summary = toolSummary(event.data.arguments)
      sinks.stderr.write(`• ${escapeTerminal(event.data.name)}${summary === '' ? '' : ` ${escapeTerminal(summary)}`}\n`)
      return
    }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const message = event.data.message
      const name = escapeTerminal(toolNames.get(message.toolCallId) ?? 'tool')
      if (message.isError !== true) {
        sinks.stderr.write(`  ✓ ${name}\n`)
        return
      }
      const first = message.content
        .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('')
        .split('\n')
        .map(line => line.trim())
        .find(line => line !== '') ?? 'failed'
      sinks.stderr.write(`  ✗ ${name}: ${escapeTerminal(oneLine(first))}\n`)
    }
  })

  return {
    printed: () => printedAny,
    dispose(): void {
      stopFrames()
      stopEvents()
      closeReasoning()
      endAnswerLine()
    },
  }
}
