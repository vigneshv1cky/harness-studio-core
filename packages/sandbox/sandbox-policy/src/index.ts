/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, and the override kit (the
 * `sandbox/mode` event, its fold, and its write path; the fold is the
 * `sandboxMode` session-projection unit registered here, while the event and
 * write path come from `./session-mode.ts`).
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

export { SANDBOX_MODES, setSandboxMode } from './session-mode.ts'

/** Preserve execution-world spelling; enforcing providers resolve filesystem identity on their host. */
function resolveWorkspaceRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error('sandbox-policy: workspace root must be an absolute execution-world path')
  return path
}

/** Width order of the modes, narrowest first. */
const MODE_WIDTH: Record<SandboxMode, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

/**
 * A mode a plugin holds one session at or below, such as read-only while plan mode is on, and the reason
 * the model is given.
 */
export interface SandboxCeiling {
  /** The widest mode the session may resolve to while the ceiling holds. */
  mode: SandboxMode
  /** Why, as a clause the model reads, such as `plan mode is on`. */
  reason: string
}

/** Reports the ceiling for one session, or `undefined` when it sets none. Called at every resolve, so it must be cheap and synchronous. */
export type SandboxCeilingSource = (session: Session) => SandboxCeiling | undefined

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: SandboxExecutionPolicy, ceiling?: SandboxCeiling): string {
  if (ceiling !== undefined) {
    return `Current DSH file policy: ${policy.mode} because ${ceiling.reason}. Operations enforced by the DSH file sandbox cannot widen past ${policy.mode} until that changes, and a sandbox escalation cannot lift it, so do not request one.`
  }
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write':
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
  /** File-sandbox mode a session starts from (default: `read-only`). */
  mode?: SandboxMode
  /**
   * Absolute fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}

/** The sandbox-mode projection's state schema (state equals the public shape). */
const sandboxModeStateSchema = zod.union([
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  zod.literal('danger-full-access'),
]).nullable()

type SandboxModeState = zod.infer<typeof sandboxModeStateSchema>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last logged sandbox-mode override, or null before one (deployment default applies at resolve time). */
    sandboxMode: SandboxModeState
  }
}

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, and current request-time policy
 * section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
  })

  static inject = ['sessionProjections']

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())

    ctx.sessionProjections.register({
      key: 'sandboxMode',
      stateVersion: 1,
      stateSchema: sandboxModeStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/mode' ? event.data.mode : state),
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          if (session === undefined) return ''
          const ceiling = this.ceilingOf(session)
          const capped = ceiling !== undefined && MODE_WIDTH[ceiling.mode] < MODE_WIDTH[this.uncappedMode({ session })]
          return renderPolicyContext(this.resolve({ session }), capped ? ceiling : undefined)
        },
      })
    })
  }

  /** Registered ceiling sources; see {@link limit}. */
  private readonly ceilings = new Set<SandboxCeilingSource>()

  /**
   * Hold sessions at or below a mode while a source reports a ceiling for them. A ceiling also caps an
   * approved escalation, so it is a hard limit for the session, not a default.
   * @param source - reports the ceiling for a session, or `undefined` for none.
   * @returns the disposer that removes the source; call it through `ctx.effect`.
   */
  limit(source: SandboxCeilingSource): () => void {
    this.ceilings.add(source)
    return () => { this.ceilings.delete(source) }
  }

  /**
   * The narrowest ceiling any source reports for a session or any session above it. A hold placed on a
   * session also holds the subagents and workflow children it starts, and theirs: each one's header names
   * its parent, which is looked up through the agents service while it is live.
   * @param session - the session to check.
   * @returns that ceiling, or `undefined` when no source sets one.
   */
  ceilingOf(session: Session): SandboxCeiling | undefined {
    if (this.ceilings.size === 0) return undefined
    let narrowest: SandboxCeiling | undefined
    const seen = new Set<string>()
    for (let current: Session | undefined = session; current !== undefined && !seen.has(current.id);) {
      seen.add(current.id)
      for (const source of this.ceilings) {
        const ceiling = source(current)
        if (ceiling !== undefined && (narrowest === undefined || MODE_WIDTH[ceiling.mode] < MODE_WIDTH[narrowest.mode])) narrowest = ceiling
      }
      const parent: SessionId | undefined = current.header.parentSession
      current = parent === undefined ? undefined : this.ctx.get('agents')?.get(parent)?.session
    }
    return narrowest
  }

  /** The mode before ceilings: an approved explicit mode, else the session override, else the deployment default. */
  private uncappedMode(request: SandboxPolicyRequest): SandboxMode {
    const { session } = request
    return request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default; the narrowest ceiling a source reports for the session
   * (see {@link limit}) then caps the result. A session cwd is its
   * workspace-write boundary; the configured root is the fallback for agentless
   * calls and sessions without a cwd.
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode and absolute workspace root.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    const uncapped = this.uncappedMode(request)
    const ceiling = session === undefined ? undefined : this.ceilingOf(session)
    return {
      mode: ceiling !== undefined && MODE_WIDTH[ceiling.mode] < MODE_WIDTH[uncapped] ? ceiling.mode : uncapped,
      workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
      ...session === undefined ? {} : { sessionId: session.id },
    }
  }

  /**
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'sandboxMode') ?? undefined
  }
}

export default SandboxPolicyService
