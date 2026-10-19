/**
 * Process streams the runner reads and writes, kept out of the package entry so
 * substituting them in tests adds no public package API. The shape matches the
 * runner's own IO carrier structurally.
 * @module @deepseek-ai/dsh-headless/runner-internals
 */

import { createInterface } from 'node:readline'
import type { ChatInput, TerminalChat } from '@deepseek-ai/dsh-terminal-chat'

/** Lines typed at an interactive terminal, for the chat mode: the shared chat input face. */
export type { ChatInput }

/** The parts of a readline interface the chat input uses; tests substitute a fake. */
export interface ChatLineSource {
  on(event: 'line', listener: (line: string) => void): unknown
  on(event: 'close' | 'SIGINT', listener: () => void): unknown
  setPrompt(prompt: string): void
  prompt(): void
  /** Clear the half-typed line (Ctrl-U) and redraw the input line with the current prompt. */
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
      // Clearing redraws the input line with the current prompt, so the question set first is what it shows.
      source.setPrompt(question)
      source.clearLine()
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
  /** Start the full-screen chat, or undefined when the terminal cannot show it or it is not installed. */
  openFullScreen: () => Promise<TerminalChat | undefined>
} = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdoutIsTerminal: () => process.stdout.isTTY === true,
  openFullScreen: async () => {
    if (process.stdout.isTTY !== true || process.stdin.isTTY !== true || process.env['TERM'] === 'dumb') return undefined
    let module: typeof import('@deepseek-ai/dsh-terminal-chat')
    try {
      module = await import('@deepseek-ai/dsh-terminal-chat')
    } catch (error) {
      // Not installed with this runner: the line chat takes over.
      void error
      return undefined
    }
    if (process.stdout.columns < module.MIN_COLUMNS) return undefined
    return module.startTerminalChat()
  },
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
