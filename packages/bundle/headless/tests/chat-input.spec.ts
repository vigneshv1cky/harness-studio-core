/** Terminal chat input: queued messages, and questions answered only by lines entered after they appear. */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createChatInput } from '../src/runner-internals.ts'

/** A stand-in for the readline interface that records prompts and clears. */
function fakeTerminal() {
  const emitter = new EventEmitter()
  const shown: string[] = []
  let prompt = '> '
  const source = {
    on: (event: 'line' | 'close' | 'SIGINT', listener: (line: string) => void) => emitter.on(event, listener),
    setPrompt: (next: string) => { prompt = next },
    prompt: () => { shown.push(prompt) },
    clearLine: () => { shown.push('(cleared)') },
    close: () => { emitter.emit('close') },
  }
  return { source, shown, type: (line: string) => { emitter.emit('line', line) }, interrupt: () => { emitter.emit('SIGINT') } }
}

describe('terminal chat input', () => {
  it('queues lines as messages, in order, and ends when closed', async () => {
    const terminal = fakeTerminal()
    const input = createChatInput(terminal.source)
    terminal.type('first')
    terminal.type('second')
    const iterator = input[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ value: 'first', done: false })
    expect(await iterator.next()).toEqual({ value: 'second', done: false })
    const waiting = iterator.next()
    terminal.type('third')
    expect(await waiting).toEqual({ value: 'third', done: false })
    input.close()
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
  })

  it('answers a question only with a line entered after it; earlier lines stay messages', async () => {
    const terminal = fakeTerminal()
    const input = createChatInput(terminal.source)
    terminal.type('y')
    const answer = input.ask('Allow once? [y/N] ')
    expect(terminal.shown).toEqual(['(cleared)', 'Allow once? [y/N] '])
    terminal.type('no thanks')
    expect(await answer).toBe('no thanks')
    input.prompt()
    expect(terminal.shown.at(-1)).toBe('> ')
    const iterator = input[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ value: 'y', done: false })
  })

  it('a withdrawn question, a closed input or an already aborted signal answers nothing', async () => {
    const terminal = fakeTerminal()
    const input = createChatInput(terminal.source)
    const controller = new AbortController()
    const withdrawn = input.ask('Allow once? [y/N] ', controller.signal)
    controller.abort()
    expect(await withdrawn).toBeUndefined()
    terminal.type('later')
    expect(await input[Symbol.asyncIterator]().next()).toEqual({ value: 'later', done: false })
    expect(await input.ask('again? ', controller.signal)).toBeUndefined()
    const open = input.ask('Allow once? [y/N] ')
    input.close()
    expect(await open).toBeUndefined()
    expect(await input.ask('after close? ')).toBeUndefined()
  })

  it('passes Ctrl-C to the chat', () => {
    const terminal = fakeTerminal()
    const input = createChatInput(terminal.source)
    let interrupted = 0
    input.onInterrupt(() => { interrupted++ })
    terminal.interrupt()
    expect(interrupted).toBe(1)
  })
})
