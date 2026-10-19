import { describe, expect, it } from 'vitest'
import { instructionBudgetSummary } from '../src/client/chat/ContextBody.tsx'
import { isCutInstructionsContext } from '../src/client/contract/chat-visibility.ts'

const t = (key: string, values?: Record<string, string>): string =>
  `${key}${values === undefined ? '' : ` ${JSON.stringify(values)}`}`

function text(body: string) {
  return [{ type: 'text' as const, text: `<system-reminder>\n${body}\n\nInstructions from: AGENTS.md\n</system-reminder>` }]
}

describe('cut workspace instructions in Chat', () => {
  it('summarises a single cut file without repeating its path', () => {
    const content = text('Workspace instruction budget 131072 bytes: truncated AGENTS.md from 174973 to 130958 bytes')
    expect(instructionBudgetSummary(content, t as never)).toBe('message.context.instructions.cut {"included":"128","original":"171"}')
  })

  it('names every omitted and cut file when there are several', () => {
    const content = text('Workspace instruction budget 2048 bytes: omitted ~/.harness-studio/AGENTS.md; truncated CLAUDE.md from 4096 to 1500 bytes')
    expect(instructionBudgetSummary(content, t as never)).toBe([
      'message.context.instructions.omitted {"paths":"~/.harness-studio/AGENTS.md"}',
      'message.context.instructions.truncated {"path":"CLAUDE.md","included":"1","original":"4"}',
    ].join(' · '))
  })

  it('stays quiet when nothing was cut', () => {
    expect(instructionBudgetSummary(text('The following workspace instructions may be relevant.'), t as never)).toBeNull()
  })

  it('shows the row only for instructions that were cut', () => {
    const cut = text('Workspace instruction budget 131072 bytes: truncated AGENTS.md from 174973 to 130958 bytes')
    expect(isCutInstructionsContext({ content: cut, source: { kind: 'agent-instructions', form: 'instructions', changes: [] } })).toBe(true)
    expect(isCutInstructionsContext({ content: text('Rules.'), source: { kind: 'agent-instructions', form: 'instructions', changes: [] } })).toBe(false)
    expect(isCutInstructionsContext({ content: cut, source: { kind: 'skill-catalog' } })).toBe(false)
  })
})
