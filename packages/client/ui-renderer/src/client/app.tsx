/**
 * Real-UI assembly closure. The whole layout tree hangs from the built-in
 * `root` slot, which is the only ctx-level slot render in the application.
 */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { RemountContext } from './bindings.tsx'

/** Inputs available after the UI renderer's inject set activates. */
export interface AssemblyDeps {
  /** Client context carrying the renderer-owned Slot registry. */
  ctx: Context
  /**
   * True when the application is mounted again into a container after the
   * renderer was replaced; the root entry and scope adapters are then waited
   * for instead of reported as boot-order failures.
   */
  remount?: boolean
}

/**
 * Build the assembled application factory.
 * @param deps - Active UI-renderer dependencies.
 * @returns Factory producing the application React tree.
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx, remount = false } = deps
  if (!remount) return () => ctx.slots.renderSlot('root', {})
  return () => (
    <RemountContext.Provider value>
      {ctx.slots.renderSlot('root', {}, { awaitRegistration: true })}
    </RemountContext.Provider>
  )
}
