/**
 * Split what the terminal sends into key presses. Ink reads stdin in chunks and treats each chunk as one key, so
 * keys that arrive together (a held arrow key, or typing while a frame is drawn) would be read as one unknown key
 * and lost. Each chunk is split here instead: escape sequences, Enter, Backspace, Tab and control keys become one
 * press each; text stays together, so a paste reaches the input box whole.
 * @module @deepseek-ai/dsh-terminal-chat/keys
 */

import type { KeyPress } from './store.ts'

/** Text with no control characters other than tab and line breaks: typed or pasted text, possibly ending in Enter. */
const TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/
/** A CSI or SS3 escape sequence: arrows, Delete, Shift-Tab and the like. */
const SEQUENCE = /^\u001b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/

/** The press an escape sequence stands for; sequences the chat does not use yield nothing. */
function sequenceKey(sequence: string): [string, KeyPress] | undefined {
  switch (sequence.at(-1) === '~' ? sequence : sequence.slice(-1)) {
    case 'A': return ['', { upArrow: true }]
    case 'B': return ['', { downArrow: true }]
    case '\u001b[3~': return ['', { delete: true }]
    default: return undefined
  }
}

/**
 * The key presses in one chunk from the terminal, in order.
 * @param data - one chunk as read from stdin in raw mode.
 * @returns each press as the text it typed and which special key it was.
 */
export function splitKeys(data: string): [string, KeyPress][] {
  if (data === '\r' || data === '\n') return [['', { return: true }]]
  // Typed or pasted text arrives whole; the input box decides whether a trailing Enter sends it.
  if (data.length > 1 && TEXT.test(data) && /[^\r\n\t]/.test(data)) return [[data, {}]]
  const presses: [string, KeyPress][] = []
  let text = ''
  const flush = (): void => {
    if (text === '') return
    presses.push([text, {}])
    text = ''
  }
  for (let index = 0; index < data.length;) {
    const sequence = SEQUENCE.exec(data.slice(index))?.[0]
    if (sequence !== undefined) {
      flush()
      const press = sequenceKey(sequence)
      if (press !== undefined) presses.push(press)
      index += sequence.length
      continue
    }
    const char = data[index] ?? ''
    index += 1
    if (char >= ' ' && char !== '\u007f') {
      text += char
      continue
    }
    flush()
    if (char === '\r' || char === '\n') presses.push(['', { return: true }])
    else if (char === '\u007f' || char === '\b') presses.push(['', { backspace: true }])
    else if (char === '\t') presses.push(['', { tab: true }])
    else if (char === '\u001b') presses.push(['', { escape: true }])
    else if (char === '\u0003') presses.push(['c', { ctrl: true }])
    else if (char === '\u0004') presses.push(['d', { ctrl: true }])
  }
  flush()
  return presses
}
