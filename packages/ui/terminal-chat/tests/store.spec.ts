/** The full-screen chat's state: what lands in the scrollback, the input queue and questions, and the keys. */

import { describe, expect, it } from 'vitest'
import { ChatStore, QUIT_WINDOW_MS } from '../src/store.ts'

const items = (store: ChatStore) => store.getSnapshot().history.map(({ id: _id, ...item }) => item)
const type = (store: ChatStore, text: string): void => {
  for (const char of text) store.key(char, {})
}

describe('full-screen chat store', () => {
  it('moves streamed answer text into the scrollback at each boundary, with tools after it', () => {
    const store = new ChatStore(() => 1000)
    const { view } = store
    view.welcome('flash', '/work')
    view.replyStart()
    expect(store.getSnapshot().busySince).toBe(1000)
    view.attemptStart(false)
    view.reasoning('think')
    view.answer('Looking')
    view.answer(' now.\n\n')
    view.blockEnd()
    view.toolCall('c1', 'bash', 'List files')
    expect(store.getSnapshot().tools).toEqual([{ id: 'c1', name: 'bash', summary: 'List files' }])
    view.toolResult('c1', 'bash', undefined)
    view.toolCall('c2', 'read', '/nope')
    view.toolResult('c2', 'read', 'ENOENT')
    view.toolResult('c3', 'grep', 'never started')
    view.attemptStart(true)
    view.answer('  \n')
    view.attemptEnd()
    view.answer('Found it.')
    view.replyEnd(undefined, 'dsh: stopped')
    view.notice('note\n')
    view.status('flash · 1K in / 2 out\n')
    view.goodbye('session-1')
    expect(items(store)).toEqual([
      { kind: 'welcome', model: 'flash', cwd: '/work' },
      { kind: 'answer', text: 'Looking now.' },
      { kind: 'tool', name: 'bash', summary: 'List files', error: undefined },
      { kind: 'tool', name: 'read', summary: '/nope', error: 'ENOENT' },
      { kind: 'tool', name: 'grep', summary: '', error: 'never started' },
      { kind: 'notice', text: '(retrying)' },
      { kind: 'answer', text: 'Found it.' },
      { kind: 'notice', text: 'dsh: stopped' },
      { kind: 'notice', text: 'note' },
      { kind: 'notice', text: 'Session session-1; continue it with --session-id session-1' },
    ])
    expect(store.getSnapshot()).toMatchObject({ busySince: undefined, reasoning: '', answer: '', tools: [], status: 'flash · 1K in / 2 out' })
  })

  it('shows an answer passed at the end of a reply that was not streamed', () => {
    const store = new ChatStore()
    store.view.replyStart()
    store.view.replyEnd('Whole answer.', undefined)
    store.view.replyEnd('', undefined)
    expect(items(store)).toEqual([{ kind: 'answer', text: 'Whole answer.' }])
  })

  it('queues entered lines in order, echoes them, and ends the iteration when closed', async () => {
    const store = new ChatStore()
    type(store, 'first')
    store.key('', { return: true })
    store.key('', { return: true })
    type(store, '  second  ')
    store.key('', { return: true })
    const lines = store.input[Symbol.asyncIterator]()
    expect(await lines.next()).toEqual({ value: 'first', done: false })
    expect(await lines.next()).toEqual({ value: 'second', done: false })
    const waiting = lines.next()
    store.key('third\r', {})
    expect(await waiting).toEqual({ value: 'third', done: false })
    expect(items(store).map(item => item.kind === 'message' ? item.text : '')).toEqual(['first', '  second  ', 'third'])
    store.input.prompt()
    store.input.close()
    store.input.close()
    expect(await lines.next()).toEqual({ value: undefined, done: true })
    store.key('x', {})
    expect(store.getSnapshot().draft).toBe('')
  })

  it('answers a question only with what is entered after it appears', async () => {
    const store = new ChatStore()
    type(store, 'half typed')
    const answer = store.input.ask('Allow once? [y/N]')
    expect(store.getSnapshot()).toMatchObject({ question: 'Allow once? [y/N]', draft: '' })
    store.key('', { upArrow: true })
    type(store, 'y')
    store.key('', { return: true })
    expect(await answer).toBe('y')
    expect(store.getSnapshot().question).toBeUndefined()
    expect(items(store)).toEqual([{ kind: 'notice', text: 'Allow once? [y/N] y' }])
    const controller = new AbortController()
    const withdrawn = store.input.ask('Allow once? [y/N]', controller.signal)
    controller.abort()
    expect(await withdrawn).toBeUndefined()
    expect(await store.input.ask('again?', controller.signal)).toBeUndefined()
    const open = store.input.ask('Allow once? [y/N]')
    store.input.close()
    expect(await open).toBeUndefined()
    expect(await store.input.ask('after close?')).toBeUndefined()
  })

  it('edits the box: backspace, a trailing backslash for a new line, pastes keep line breaks, history with arrows', () => {
    const store = new ChatStore()
    store.key('', { upArrow: true })
    type(store, 'abc')
    store.key('', { backspace: true })
    store.key('', { delete: true })
    expect(store.getSnapshot().draft).toBe('a')
    type(store, '\\')
    store.key('', { return: true })
    expect(store.getSnapshot().draft).toBe('a\n')
    store.key('line one\r\nline two\rthree', {})
    expect(store.getSnapshot().draft).toBe('a\nline one\nline two\nthree')
    store.key('', { return: true })
    type(store, 'second')
    store.key('', { return: true })
    store.key('x', { ctrl: true })
    store.key('x', { meta: true })
    store.key('', { tab: true })
    store.key('', {})
    store.key('', { upArrow: true })
    expect(store.getSnapshot().draft).toBe('second')
    store.key('', { upArrow: true })
    store.key('', { upArrow: true })
    expect(store.getSnapshot().draft).toBe('a\nline one\nline two\nthree')
    store.key('', { downArrow: true })
    store.key('', { downArrow: true })
    store.key('', { downArrow: true })
    expect(store.getSnapshot().draft).toBe('')
  })

  it('Esc and Ctrl-C stop a running reply; idle, Ctrl-C clears the box, then quits on a second press in time', () => {
    let now = 0
    const store = new ChatStore(() => now)
    let interrupts = 0
    store.input.onInterrupt(() => { interrupts++ })
    store.key('', { escape: true })
    expect(interrupts).toBe(0)
    store.view.replyStart()
    store.key('', { escape: true })
    store.key('c', { ctrl: true })
    expect(interrupts).toBe(2)
    store.view.replyEnd(undefined, undefined)
    type(store, 'draft')
    store.key('c', { ctrl: true })
    expect(store.getSnapshot().draft).toBe('')
    store.key('c', { ctrl: true })
    expect(store.getSnapshot().hint).toBe('Press Ctrl-C again to quit')
    now += QUIT_WINDOW_MS + 1
    store.key('c', { ctrl: true })
    expect(interrupts).toBe(2)
    type(store, 'x')
    expect(store.getSnapshot().hint).toBeUndefined()
    store.key('', { backspace: true })
    store.key('c', { ctrl: true })
    now += 10
    store.key('c', { ctrl: true })
    expect(interrupts).toBe(3)
  })

  it('Ctrl-D quits on an empty box only', async () => {
    const store = new ChatStore()
    type(store, 'x')
    store.key('d', { ctrl: true })
    expect(store.getSnapshot().closed).toBe(false)
    store.key('', { backspace: true })
    store.key('d', { ctrl: true })
    expect(store.getSnapshot().closed).toBe(true)
    expect(await store.input[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true })
  })

  it('stops notifying a listener once unsubscribed', () => {
    const store = new ChatStore()
    let calls = 0
    const stop = store.subscribe(() => { calls++ })
    store.view.status('a')
    stop()
    store.view.status('b')
    expect(calls).toBe(1)
  })
})
