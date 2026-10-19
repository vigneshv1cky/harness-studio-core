/** The full-screen chat drawn by Ink on a stand-in terminal. */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { elapsed, lastLine, startTerminalChat } from '../src/index.ts'

/** A terminal stand-in: a writable stdout 80 columns wide and a raw-mode stdin that keys can be sent to. */
function fakeTerminal() {
  let written = ''
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80, rows: 30, isTTY: true,
    write: (chunk: string, done?: () => void) => { written += chunk; done?.(); return true },
  })
  const input = new EventEmitter()
  const stdin = Object.assign(input, {
    isTTY: true, rawModes: [] as boolean[],
    setRawMode(mode: boolean) { this.rawModes.push(mode); return this },
    setEncoding() { return this }, ref() { return this }, unref() { return this }, resume() { return this }, pause() { return this },
    queued: [] as string[],
    read() { return this.queued.shift() ?? null },
    send(text: string) { this.queued.push(text); input.emit('readable') },
  })
  return { stdout, stdin, screen: () => written.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 60) })

describe('full-screen chat app', () => {
  it('draws the welcome box, messages, tools, the spinner, the input box and the footer, and reads keys', async () => {
    const terminal = fakeTerminal()
    const chat = startTerminalChat({ stdin: terminal.stdin as never, stdout: terminal.stdout as never })
    expect(terminal.stdin.rawModes[0]).toBe(true)
    chat.view.welcome('flash', '/work')
    terminal.stdin.send('hi')
    await settle()
    terminal.stdin.send('\r')
    await settle()
    chat.view.replyStart()
    chat.view.reasoning('first thought\nsecond thought')
    chat.view.toolCall('c1', 'bash', 'List files')
    chat.view.answer('Streaming…')
    await settle()
    const live = terminal.screen()
    expect(live).toContain('✻ Harness Studio')
    expect(live).toContain('flash · /work')
    expect(live).toContain('> hi')
    expect(live).toContain('⏺ bash(List files)')
    expect(live).toContain('Running…')
    expect(live).toMatch(/Thinking… \ds · Esc to stop/)
    expect(live).toContain('second thought')
    chat.view.toolResult('c1', 'bash', 'exit 1')
    chat.view.replyEnd(undefined, undefined)
    chat.view.status('flash · 1K in / 2 out')
    const question = chat.input.ask('Allow once? [y/N]')
    await settle()
    expect(terminal.screen()).toContain('⎿  exit 1')
    expect(terminal.screen()).toContain('Allow once? [y/N]')
    terminal.stdin.send('y')
    await settle()
    terminal.stdin.send('\r')
    expect(await question).toBe('y')
    await settle()
    expect(terminal.screen()).toContain('flash · 1K in / 2 out')
    chat.view.commands([{ name: 'help', description: 'List the commands' }, { name: 'plan', description: 'Plan mode', input: { hint: '[off|message]' } }])
    terminal.stdin.send('/')
    await settle()
    expect(terminal.screen()).toContain('❯ /help')
    expect(terminal.screen()).toMatch(/  \/plan +Plan mode/)
    terminal.stdin.send('\x1b[B')
    await settle()
    expect(terminal.screen()).toMatch(/❯ \/plan +\[off\|message\] +Plan mode/)
    terminal.stdin.send('\x7f')
    await settle()
    const decision = chat.input.choose?.({ title: 'bash needs your approval', detail: 'outside the workspace', options: [{ label: 'Yes, once', value: 'yes' }, { label: 'No', value: 'no' }], initial: 1, escape: 'no' })
    await settle()
    expect(terminal.screen()).toContain('bash needs your approval')
    expect(terminal.screen()).toContain('❯ 2. No')
    expect(terminal.screen()).toContain('↑↓ to choose · Enter to confirm · Esc to say no')
    terminal.stdin.send('\r')
    expect(await decision).toBe('no')
    await chat.close()
  })

  it('formats elapsed time and the reasoning line', () => {
    expect([0, 8_400, 65_000, -5].map(elapsed)).toEqual(['0s', '8s', '1m 05s', '0s'])
    expect(lastLine('a\n\n  b  \n')).toBe('b')
    expect(lastLine('')).toBe('')
    expect(lastLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})
