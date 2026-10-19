/**
 * Harness Studio: the full-screen terminal chat for the harness-studio command, drawn with Ink in the style of
 * Claude Code. The headless runner's chat loop keeps the agent, commands and approvals; this package only draws
 * and reads keys, through the {@link ChatView} and {@link ChatInput} faces the line chat also implements.
 * @module @deepseek-ai/dsh-terminal-chat
 */

import { createElement } from 'react'
import { render } from 'ink'
import { TerminalChatApp } from './app.ts'
import { ChatStore } from './store.ts'
import type { ChatInput, ChatView } from './contract.ts'

export type { ChatInput, ChatView } from './contract.ts'
export { ChatStore, QUIT_WINDOW_MS, type ChatState, type HistoryItem, type KeyPress, type RunningTool } from './store.ts'
export { TerminalChatApp, elapsed, lastLine, SPINNER } from './app.ts'

/** The smallest terminal width the full-screen chat is drawn in; narrower terminals get the line chat. */
export const MIN_COLUMNS = 40

/** One running full-screen chat. */
export interface TerminalChat {
  readonly view: ChatView
  readonly input: ChatInput
  /** Close the input, draw the last frame and release the terminal. */
  close(): Promise<void>
}

/**
 * Draw the full-screen chat on the terminal.
 * @param options - the streams to draw on and read from; the process's by default.
 * @returns the chat's view, input and close.
 */
export function startTerminalChat(options: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {}): TerminalChat {
  const store = new ChatStore()
  const stdin = options.stdin ?? process.stdin
  // Raw mode before the first frame: Ink turns it on in an effect, which waits while the runner is still busy
  // starting up, and until then the terminal would echo typing over the frame and hold it back until Enter.
  if (stdin.isTTY) stdin.setRawMode(true)
  // Ctrl-C belongs to the chat (stop a reply, clear the box, quit on the second press), not to Ink.
  const instance = render(createElement(TerminalChatApp, { store }), {
    stdin,
    stdout: options.stdout ?? process.stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return {
    view: store.view,
    input: store.input,
    async close() {
      store.close()
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      // Ink resolves the exit only for a wait that began before the unmount.
      const exited = instance.waitUntilExit()
      instance.unmount()
      await exited
    },
  }
}
