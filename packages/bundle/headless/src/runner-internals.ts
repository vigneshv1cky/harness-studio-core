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
}

/** The process streams the runner reads and writes; tests substitute captures. */
export const internals: {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  readStdin: () => Promise<string>
  openChat: () => ChatInput
} = {
  stdout: process.stdout,
  stderr: process.stderr,
  readStdin: async () => {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  },
  openChat: () => {
    // The prompt and echo go to stderr, so stdout carries only the answers.
    const lines = createInterface({ input: process.stdin, output: process.stderr, prompt: '> ', terminal: true })
    return {
      [Symbol.asyncIterator]: () => lines[Symbol.asyncIterator](),
      prompt: () => { lines.prompt() },
      onInterrupt: (listener) => { lines.on('SIGINT', listener) },
      close: () => { lines.close() },
    }
  },
}
