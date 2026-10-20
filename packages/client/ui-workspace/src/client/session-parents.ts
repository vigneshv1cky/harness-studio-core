/**
 * Registered presentation-parent sources for the Workspace browser. A client
 * plugin that starts Sessions on another Session's behalf registers the
 * parent links it owns; the browser reads one merged map and nests each
 * child under its parent's row.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionParents } from './tree.ts'

const EMPTY: SessionParents = new Map()

/**
 * Ordered set of parent sources plus their merged view. The earliest
 * registration wins a child both sources name; the merged snapshot keeps its
 * identity until a source snapshot or the registration list changes.
 */
export class SessionParentRegistry {
  private sources: readonly HostObservable<SessionParents>[] = []
  private readonly listListeners = new Set<() => void>()
  private seen: readonly SessionParents[] = []
  private merged: SessionParents = EMPTY

  /** Merged parents of every registered source. */
  readonly parents: HostObservable<SessionParents> = {
    getSnapshot: () => this.snapshot(),
    subscribe: (listener) => {
      let detach: (() => void)[] = []
      const attach = (): void => {
        for (const stop of detach) stop()
        detach = this.sources.map(source => source.subscribe(listener))
      }
      attach()
      const onList = (): void => {
        attach()
        listener()
      }
      this.listListeners.add(onList)
      return () => {
        this.listListeners.delete(onList)
        for (const stop of detach) stop()
      }
    },
  }

  /**
   * Add one parent source.
   * @param source - child-to-parent links; iteration order orders siblings.
   * @returns the disposer that removes the source.
   */
  register(source: HostObservable<SessionParents>): () => void {
    this.sources = [...this.sources, source]
    this.notifyList()
    return () => {
      if (!this.sources.includes(source)) return
      this.sources = this.sources.filter(entry => entry !== source)
      this.notifyList()
    }
  }

  private notifyList(): void {
    for (const listener of [...this.listListeners]) listener()
  }

  private snapshot(): SessionParents {
    const snapshots = this.sources.map(source => source.getSnapshot())
    if (snapshots.length === this.seen.length && snapshots.every((value, index) => value === this.seen[index])) {
      return this.merged
    }
    this.seen = snapshots
    if (snapshots.length <= 1) this.merged = snapshots[0] ?? EMPTY
    else {
      const merged = new Map<SessionId, SessionId>()
      for (const parents of snapshots) {
        for (const [child, parent] of parents) if (!merged.has(child)) merged.set(child, parent)
      }
      this.merged = merged
    }
    return this.merged
  }
}
