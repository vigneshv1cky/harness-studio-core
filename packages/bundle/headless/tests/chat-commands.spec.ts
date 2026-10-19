/** Terminal chat help and status line formatting. */

import { describe, expect, it } from 'vitest'
import { chatHelp, shortTokens, statusLine } from '../src/chat-commands.ts'

describe('terminal chat commands', () => {
  it('lists the chat\'s own commands first, then registered ones with their input hints, aligned', () => {
    const help = chatHelp([
      { name: 'compact', description: 'Compact older history' },
      { name: 'plan', description: 'Plan mode', input: { hint: '[off|message]' } },
      { name: 'help', description: 'A registered help the chat\'s own help shadows' },
    ])
    expect(help).toBe(`${[
      '  /help                List the commands',
      '  /clear               Start a new session; the current one can still be continued with --session-id',
      '  /model               Show the model this chat uses',
      '  /exit                Quit (also Ctrl-D)',
      '  /compact             Compact older history',
      '  /plan [off|message]  Plan mode',
    ].join('\n')}\n`)
  })

  it('shortens token counts', () => {
    expect([0, 950, 1000, 9_949, 12_345, 999_999, 1_200_000].map(shortTokens)).toEqual(['0', '950', '1.0K', '9.9K', '12K', '1000K', '1.2M'])
  })

  it('prints the parts of the status line that are known', () => {
    expect(statusLine({ model: 'flash' })).toBe('flash\n')
    expect(statusLine({
      model: 'flash', lastRequest: { input: 23_521, output: 159 }, context: { used: 23_521, window: 1_000_000 }, permission: 'workspace-write',
    })).toBe('flash · 24K in / 159 out · context 2% · workspace-write\n')
    expect(statusLine({ model: 'flash', context: { used: 5, window: 0 } })).toBe('flash\n')
  })
})
