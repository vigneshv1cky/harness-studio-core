/**
 * Harness Studio: the line chat's view. Answers go to stdout; reasoning, tool lines and the chat's own messages go to
 * stderr, as plain lines. The full-screen chat (`@deepseek-ai/dsh-terminal-chat`) implements the same view.
 * @module @deepseek-ai/dsh-headless/chat-line-view
 */

import type { ChatView } from '@deepseek-ai/dsh-terminal-chat'

/** Where the line chat prints. */
export interface LineSinks {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

/**
 * The line chat's view over two streams.
 * @param sinks - stdout for the answer, stderr for everything else.
 * @returns the view.
 */
export function createLineView(sinks: LineSinks): ChatView {
  let reasoningOpen = false
  let reasoningEndsLine = true
  let answerEndsLine = true
  let printed = false

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

  return {
    welcome(model, cwd) {
      sinks.stderr.write(`Chat with ${model} in ${cwd}. Enter sends; /help lists commands; Ctrl-C stops a reply; Ctrl-D or /exit quits.\n`)
    },
    replyStart() {
      printed = false
    },
    attemptStart(retry) {
      closeReasoning()
      endAnswerLine()
      if (retry) sinks.stderr.write('(retrying)\n')
    },
    reasoning(text) {
      if (!reasoningOpen) {
        endAnswerLine()
        sinks.stderr.write('dsh: reasoning:\n')
        reasoningOpen = true
      }
      sinks.stderr.write(text)
      reasoningEndsLine = text.endsWith('\n')
    },
    answer(text) {
      sinks.stdout.write(text)
      answerEndsLine = text.endsWith('\n')
      printed = true
    },
    blockEnd() {
      closeReasoning()
    },
    attemptEnd() {
      closeReasoning()
      endAnswerLine()
    },
    toolCall(_id, name, summary) {
      closeReasoning()
      endAnswerLine()
      sinks.stderr.write(`• ${name}${summary === '' ? '' : ` ${summary}`}\n`)
    },
    toolResult(_id, name, error) {
      sinks.stderr.write(error === undefined ? `  ✓ ${name}\n` : `  ✗ ${name}: ${error}\n`)
    },
    replyEnd(answer, problem) {
      closeReasoning()
      endAnswerLine()
      if (printed) sinks.stdout.write('\n')
      else if (answer !== undefined && answer !== '') sinks.stdout.write(`${answer}\n\n`)
      if (problem !== undefined) sinks.stderr.write(`${problem}\n`)
    },
    notice(text) {
      sinks.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
    },
    status(line) {
      sinks.stderr.write(line.endsWith('\n') ? line : `${line}\n`)
    },
    goodbye(sessionId) {
      sinks.stderr.write(`\nSession ${sessionId}; continue it with --session-id ${sessionId}\n`)
    },
  }
}
