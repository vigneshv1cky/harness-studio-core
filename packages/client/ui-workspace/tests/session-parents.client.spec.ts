import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionParentRegistry } from '../src/client/session-parents.ts'

const sid = (id: string) => id as SessionId
/** A synchronous observable cell. */
function createSnapshotStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next: T) => {
      value = next
      for (const listener of listeners) listener()
    },
  }
}
const links = (...pairs: [string, string][]): ReadonlyMap<SessionId, SessionId> =>
  new Map(pairs.map(([child, parent]) => [sid(child), sid(parent)]))

describe('SessionParentRegistry', () => {
  it('merges registered sources with the earliest registration winning a shared child', () => {
    const registry = new SessionParentRegistry()
    expect(registry.parents.getSnapshot().size).toBe(0)
    const first = createSnapshotStore(links(['a', 'p']))
    const second = createSnapshotStore(links(['a', 'q'], ['b', 'q']))
    const disposeFirst = registry.register(first)
    expect(registry.parents.getSnapshot()).toBe(first.getSnapshot())
    const disposeSecond = registry.register(second)
    const merged = registry.parents.getSnapshot()
    expect([...merged]).toEqual([[sid('a'), sid('p')], [sid('b'), sid('q')]])
    expect(registry.parents.getSnapshot()).toBe(merged)
    disposeFirst()
    disposeFirst()
    expect(registry.parents.getSnapshot()).toBe(second.getSnapshot())
    disposeSecond()
    expect(registry.parents.getSnapshot().size).toBe(0)
  })

  it('notifies subscribers of source changes and registrations until they unsubscribe', () => {
    const registry = new SessionParentRegistry()
    const listener = vi.fn()
    const source = createSnapshotStore(links())
    const stop = registry.parents.subscribe(listener)
    const dispose = registry.register(source)
    expect(listener).toHaveBeenCalledTimes(1)
    source.set(links(['a', 'p']))
    expect(listener).toHaveBeenCalledTimes(2)
    expect([...registry.parents.getSnapshot()]).toEqual([[sid('a'), sid('p')]])
    const later = createSnapshotStore(links(['b', 'q']))
    const disposeLater = registry.register(later)
    expect(listener).toHaveBeenCalledTimes(3)
    later.set(links())
    expect(listener).toHaveBeenCalledTimes(4)
    stop()
    source.set(links())
    dispose()
    disposeLater()
    expect(listener).toHaveBeenCalledTimes(4)
  })
})
