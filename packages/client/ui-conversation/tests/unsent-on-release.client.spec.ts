/**
 * A message sent while its Session scope is being torn down (a new Session replacing the blank one the
 * composer belonged to) is given back, never silently dropped with the cleared composer.
 */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { SessionInputShell, type SessionInputDeps } from '../src/client/input/facade.ts'
import type { SubmitOutcome } from '../src/client/contract/input.ts'

function shell(deps: Partial<SessionInputDeps>): SessionInputShell {
  return new SessionInputShell({
    actx: new Context(),
    defaultSink: vi.fn(),
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' },
    ...deps,
  })
}

/** A sink that waits for its signal and then fails the way an aborted prompt does. */
function abortableSink(): SessionInputDeps['defaultSink'] {
  return (_text, _ids, _mode, signal) => new Promise<SubmitOutcome>((resolve) => {
    signal.addEventListener('abort', () => { resolve({ kind: 'error' }) })
  })
}

it('gives the text of a send cut off by release back to its owner', async () => {
  const orphaned = vi.fn()
  const input = shell({ defaultSink: abortableSink(), orphaned })
  input.setDraft('build the login page')
  input.submit('queue')
  await vi.waitFor(() => { expect(input.state.getSnapshot().draft).toBe('') })
  input.dispose()
  await vi.waitFor(() => { expect(orphaned).toHaveBeenCalledWith('build the login page') })
})

it('gives back a send whose sink rejects after release, but not one the Host accepted', async () => {
  const orphaned = vi.fn()
  let accept!: (outcome: SubmitOutcome) => void
  const accepted = shell({ defaultSink: () => new Promise<SubmitOutcome>((resolve) => { accept = resolve }), orphaned })
  accepted.setDraft('delivered')
  accepted.submit('queue')
  await vi.waitFor(() => { expect(accepted.state.getSnapshot().draft).toBe('') })
  accepted.dispose()
  accept({ kind: 'success' })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(orphaned).not.toHaveBeenCalled()

  const rejecting = shell({ defaultSink: (_t, _i, _m, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('aborted')) }) }), orphaned })
  rejecting.setDraft('not delivered')
  rejecting.submit('queue')
  await vi.waitFor(() => { expect(rejecting.state.getSnapshot().draft).toBe('') })
  rejecting.dispose()
  await vi.waitFor(() => { expect(orphaned).toHaveBeenCalledWith('not delivered') })
})

it('restores unsent text into a composer, keeping anything typed there since', () => {
  const input = shell({})
  try {
    expect(input.restoreUnsent('first message')).toBe(true)
    expect(input.state.getSnapshot().draft).toBe('first message')
    input.setDraft('typed since')
    expect(input.restoreUnsent('first message')).toBe(true)
    expect(input.state.getSnapshot().draft).toBe('first message\n\ntyped since')
  } finally { input.dispose() }
  expect(input.restoreUnsent('too late')).toBe(false)
})
