/**
 * Process streams the runner reads and writes, kept out of the package entry so
 * substituting them in tests adds no public package API. The shape matches the
 * runner's own IO carrier structurally.
 * @module @deepseek-ai/dsh-headless/runner-internals
 */

import { createInterface } from 'node:readline'

/** Lines typed at an interactive terminal, for the chat mode. */
export interface ChatInput extends AsyncIterable<string> {
  /** Show the prompt for the next line. */
  prompt(): void
  /** Run `listener` on Ctrl-C instead of ending the process. */
  onInterrupt(listener: () => void): void
  /** Stop reading; the iteration then ends. */
  close(): void
  /**
   * Ask one question and read the answer. Only a line entered after the question appeared answers it: lines entered
   * earlier stay queued as messages, and text half-typed when it appears is cleared.
   * @param question - the prompt shown on the input line.
   * @param signal - withdraws the question.
   * @returns the line, or undefined when the question was withdrawn or input ended.
   */
  ask(question: string, signal?: AbortSignal): Promise<string | undefined>
}

/** The parts of a readline interface the chat input uses; tests substitute a fake. */
export interface ChatLineSource {
  on(event: 'line', listener: (line: string) => void): unknown
  on(event: 'close' | 'SIGINT', listener: () => void): unknown
  setPrompt(prompt: string): void
  prompt(): void
  /** Clear the half-typed line (Ctrl-U). */
  clearLine(): void
  close(): void
}

/**
 * Chat input over a line source: entered lines queue for the iteration, except the one answering an open question.
 * @param source - the readline interface, or a test fake.
 * @param prompt - the message prompt, restored after a question.
 * @returns the chat input.
 */
export function createChatInput(source: ChatLineSource, prompt = '> '): ChatInput {
  const queued: string[] = []
  let closed = false
  let wake: (() => void) | undefined
  let answer: ((line: string | undefined) => void) | undefined
  source.on('line', (line) => {
    if (answer !== undefined) {
      const settle = answer
      answer = undefined
      settle(line)
      return
    }
    queued.push(line)
    wake?.()
  })
  source.on('close', () => {
    closed = true
    const settle = answer
    answer = undefined
    settle?.(undefined)
    wake?.()
  })
  return {
    async* [Symbol.asyncIterator]() {
      while (true) {
        const line = queued.shift()
        if (line !== undefined) {
          yield line
          continue
        }
        if (closed) return
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    },
    prompt: () => { source.prompt() },
    onInterrupt: (listener) => { source.on('SIGINT', listener) },
    close: () => { source.close() },
    ask(question, signal) {
      if (closed || signal?.aborted === true) return Promise.resolve(undefined)
      source.clearLine()
      source.setPrompt(question)
      source.prompt()
      return new Promise((resolve) => {
        const finish = (line: string | undefined): void => {
          signal?.removeEventListener('abort', withdraw)
          source.setPrompt(prompt)
          resolve(line)
        }
        const withdraw = (): void => {
          if (answer === finish) answer = undefined
          finish(undefined)
        }
        answer = finish
        signal?.addEventListener('abort', withdraw, { once: true })
      })
    },
  }
}

/** The process streams the runner reads and writes; tests substitute captures. */
export const internals: {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  readStdin: () => Promise<string>
  openChat: () => ChatInput
  /** Whether stdout is a terminal, so printed model text must be escaped and the chat may stream its answer. */
  stdoutIsTerminal: () => boolean
} = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdoutIsTerminal: () => process.stdout.isTTY === true,
  readStdin: async () => {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  },
  openChat: () => {
    // The prompt and echo go to stderr, so stdout carries only the answers.
    const lines = createInterface({ input: process.stdin, output: process.stderr, prompt: '> ', terminal: true })
    return createChatInput({
      on: (event: 'line' | 'close' | 'SIGINT', listener: (line: string) => void) => lines.on(event, listener),
      setPrompt: (prompt) => { lines.setPrompt(prompt) },
      prompt: () => { lines.prompt() },
      clearLine: () => { lines.write(null, { ctrl: true, name: 'u' }) },
      close: () => { lines.close() },
    })
  },
}
