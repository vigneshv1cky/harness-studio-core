/** Terminal chat output helpers: control-character escaping and tool-call summaries. */

import { describe, expect, it } from 'vitest'
import { escapeTerminal, toolSummary } from '../src/chat-stream.ts'

describe('terminal chat output', () => {
  it('shows control characters instead of sending them, keeping tab, newline and other text', () => {
    expect(escapeTerminal('a\tb\nc')).toBe('a\tb\nc')
    expect(escapeTerminal('\u001b[2J\r\u0007\u007f\u009b31m')).toBe('\\x1b[2J\\x0d\\x07\\x7f\\x9b31m')
    expect(escapeTerminal('héllo ✓ 中文')).toBe('héllo ✓ 中文')
  })

  it('summarises a tool call by its most telling argument on one short line', () => {
    expect(toolSummary('{"command":"ls","description":"List files"}')).toBe('List files')
    expect(toolSummary('{"file_path":"/a/b.ts","limit":10}')).toBe('/a/b.ts')
    expect(toolSummary('{"command":"echo one\\n  && echo two"}')).toBe('echo one && echo two')
    expect(toolSummary(JSON.stringify({ query: 'x'.repeat(100) }))).toBe(`${'x'.repeat(79)}…`)
    expect(toolSummary('{"limit":10}')).toBe('')
    expect(toolSummary('not json')).toBe('')
    expect(toolSummary('null')).toBe('')
  })
})
