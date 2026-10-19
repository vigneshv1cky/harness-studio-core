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

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { SandboxExecutionPolicy, SandboxMode, SandboxNetwork, SandboxProvider, SandboxReadDeny, SandboxReadDenyCoverage } from '@deepseek-ai/dsh-sandbox'
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

/** The network modes, in the order a setting offers them. */
export const NETWORK_MODES = ['on', 'off', 'allowlist'] as const

/**
 * Well-known secret locations `protectSecrets` hides from confined commands and the agent's file tools: SSH
 * keys, cloud and registry credentials, and plaintext password stores. `~/` is the user's home directory.
 */
export const SECRET_PATHS = [
  '~/.ssh', '~/.aws', '~/.config/gcloud', '~/.azure', '~/.kube', '~/.netrc', '~/.git-credentials', '~/.npmrc',
  '~/.docker/config.json', '~/.env',
] as const

/**
 * Harness Studio: cloud command-line logins a person may expose to confined commands. Each is one of
 * {@link SECRET_PATHS}; exposing it makes the folder readable and writable to commands in `workspace-write`, so
 * the CLI runs as the person and can refresh its tokens. Everything else stays hidden.
 */
export const CLOUD_LOGINS = {
  gcloud: { path: '~/.config/gcloud', label: 'Google Cloud (gcloud)' },
  aws: { path: '~/.aws', label: 'AWS (aws)' },
  azure: { path: '~/.azure', label: 'Azure (az)' },
  kubernetes: { path: '~/.kube', label: 'Kubernetes (kubectl)' },
} as const

/** A cloud login {@link CLOUD_LOGINS} names. */
export type CloudLogin = keyof typeof CLOUD_LOGINS

/** Paths inside {@link SECRET_PATHS} that stay readable: they hold no keys, and ssh needs them to connect through an agent. */
export const SECRET_EXCEPTIONS = ['~/.ssh/known_hosts', '~/.ssh/config'] as const

/** Expand a leading `~/` to the home directory; other paths must already be absolute. */
function expandHome(path: string, home: string): string {
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
  if (!isAbsolute(expanded)) throw new Error(`sandbox-policy: protected path ${JSON.stringify(path)} must be absolute or start with ~/`)
  return expanded
}

/** Spell a path for the model, with the home directory as `~`. */
function displayPath(path: string, home: string): string {
  return path === home ? '~' : path.startsWith(home + '/') ? `~${path.slice(home.length)}` : path
}

/**
 * Sentences on the hidden secret files, or '' when nothing is hidden. They say only what is true where the
 * next command runs: `coverage` is how completely the sandbox backend hides the files from commands (the
 * agent's file tools refuse them everywhere). `escalatable` is false while a ceiling holds the session.
 */
function renderSecretsContext(deny: SandboxReadDeny | undefined, escalatable: boolean, coverage: SandboxReadDenyCoverage): string {
  if (deny === undefined) return ''
  const home = homedir()
  const except = deny.except.length === 0 ? '' : ` (except ${deny.except.map(path => displayPath(path, home)).join(', ')})`
  const listed = `${deny.paths.map(path => displayPath(path, home)).join(', ')}${except}`
  const dotenv = deny.dotenvOutsideWorkspace ? ', and .env files outside the workspace' : ''
  const retry = escalatable ? ' A command that genuinely needs one, such as git over ssh without an ssh agent, can be retried once with sandbox_permissions danger-full-access, which the user must approve.' : ''
  switch (coverage) {
    case 'full':
      return ` Secret files are hidden from commands and file tools: ${listed}${dotenv}. Reading them fails with "Operation not permitted"; do not look for copies elsewhere.${retry}`
    case 'listed': {
      const dotenvNote = deny.dotenvOutsideWorkspace ? ' .env files outside the workspace are hidden from the file tools only: commands on this computer can still read them, so do not read them with commands either.' : ''
      return ` Secret files are hidden from commands and file tools: ${listed}; commands see an empty folder or an empty file in their place.${dotenvNote} Do not look for copies elsewhere.${retry}`
    }
    case 'none':
      return ` Secret files are hidden from the file tools only: ${listed}${dotenv}. This computer's sandbox cannot hide files from commands, so commands can still read them; do not read or send them with commands, and do not look for copies elsewhere.`
    /* v8 ignore next 4 -- SandboxReadDenyCoverage is a typed same-process closed union; this is the exhaustiveness guard. */
    default: {
      const never: never = coverage
      throw new Error(`unreachable read-deny coverage: ${String(never)}`)
    }
  }
}

/** The sentence telling the model which cloud logins its commands can use, or '' when none. */
function renderCloudLoginsContext(logins: readonly CloudLogin[]): string {
  if (logins.length === 0) return ''
  const names = logins.map(login => CLOUD_LOGINS[login].label).join(', ')
  return ` The user has made these cloud command-line logins available to commands: ${names}. Their CLIs run as the user without signing in again; the first such command in a session asks the user once.`
}

/** Host entries the allowlist accepts: a DNS name or IP address, optionally `*.` for subdomains. */
const HOST_ENTRY = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/**
 * Normalize allowlist entries: lower case, scheme, path and port dropped, invalid and repeated entries
 * removed.
 * @param hosts - entries as a person typed them, such as `https://Registry.npmjs.org/`.
 * @returns the entries the proxy compares against.
 */
export function normalizeHosts(hosts: readonly unknown[]): string[] {
  const out: string[] = []
  for (const raw of hosts) {
    if (typeof raw !== 'string') continue
    const host = raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '')
    if (HOST_ENTRY.test(host) && !out.includes(host)) out.push(host)
  }
  return out
}

/**
 * What a limited network policy does not stop, per platform, in the words the model is told. Loopback stays
 * reachable for local dev servers and databases, so programs on this computer that forward traffic remain a
 * way out, and system services act outside the sandbox altogether.
 */
export const NETWORK_LEAKS: Readonly<Record<'darwin' | 'linux' | 'other', string>> = {
  darwin: 'This is not a complete barrier: programs on this computer that forward traffic, such as local proxies and SSH tunnels listening on its loopback interface, can still be reached, and system services (opening a URL with open, launchd jobs) can make requests outside the sandbox.',
  linux: 'This is not a complete barrier: programs on this computer reachable through a Unix socket, such as a local proxy or SSH tunnel listening on one, the Docker socket, or D-Bus (and systemd-run through it), can still make requests outside the sandbox.',
  other: 'This is not a complete barrier: programs on this computer that forward traffic, such as local proxies and SSH tunnels, can still be reached, and system services can make requests outside the sandbox.',
}

/**
 * Sentences on the network policy, or '' when it is `on`. `escalatable` is false while a ceiling holds
 * the session, since an escalation cannot widen it then.
 */
function renderNetworkContext(network: SandboxNetwork | undefined, escalatable: boolean): string {
  const retry = escalatable ? ' A command that needs more network access can be retried once with sandbox_permissions danger-full-access, which the user must approve.' : ''
  const leaks = ` ${NETWORK_LEAKS[process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'other']} Do not use them to get around this setting.`
  switch (network?.mode) {
    case undefined:
    case 'on':
      return ''
    case 'off':
      return ` Network for commands: off. Direct connections to other computers are blocked, so downloads, package installs and git fetches normally fail.${leaks}${retry}`
    case 'allowlist':
      return ` Network for commands: only ${network.hosts.length === 0 ? 'no hosts' : network.hosts.join(', ')}, through a proxy set in HTTP_PROXY and HTTPS_PROXY; other hosts are refused with HTTP 403, and direct connections are blocked, so programs that ignore those variables cannot connect directly.${leaks}${retry}`
    /* v8 ignore next 4 -- SandboxNetwork is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = network
      throw new Error(`unreachable network mode: ${String(mode)}`)
    }
  }
}

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(
  policy: SandboxExecutionPolicy, ceiling: SandboxCeiling | undefined, coverage: SandboxReadDenyCoverage,
): string {
  if (policy.mode === 'danger-full-access') return renderFileContext(policy, ceiling)
  const escalatable = ceiling === undefined
  return renderFileContext(policy, ceiling)
    + renderNetworkContext(policy.network, escalatable)
    + renderSecretsContext(policy.readDeny, escalatable, coverage)
}

function renderFileContext(policy: SandboxExecutionPolicy, ceiling?: SandboxCeiling): string {
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
  /** Network for confined commands (default: `on`). */
  network?: SandboxNetwork['mode']
  /** Hosts `allowlist` admits; see {@link SandboxNetwork} (default: none). */
  allowedHosts?: string[]
  /**
   * Absolute path of a JSON file `{ "network": "on" | "off" | "allowlist", "allowedHosts": [...] }` whose
   * fields, when present and valid, replace `network` and `allowedHosts`. It is re-read when it changes, so a
   * settings page can change the policy without a restart. Absent: only the configured values apply.
   */
  networkFile?: string
  /**
   * Hide well-known secret files ({@link SECRET_PATHS}, less {@link SECRET_EXCEPTIONS}) and dotenv files
   * outside the workspace from confined commands and the agent's file tools (default: false).
   */
  protectSecrets?: boolean
  /** More files or directories to hide while `protectSecrets` is on: absolute, or starting with `~/` (default: none). */
  protectedPaths?: string[]
  /**
   * Harness Studio: absolute path of a JSON file `{ "enabled": ["gcloud", "aws", ...] }` naming the
   * {@link CLOUD_LOGINS} exposed to confined commands; read again whenever it changes. Absent exposes none.
   */
  cloudLoginsFile?: string
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
    network: z.union(['on', 'off', 'allowlist'] as const).default('on'),
    allowedHosts: z.array(z.string()).default([]),
    networkFile: z.string(),
    protectSecrets: z.boolean().default(false),
    protectedPaths: z.array(z.string()).default([]),
    cloudLoginsFile: z.string(),
  })

  static inject = ['sessionProjections']

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  /** The configured network policy, beneath the saved file's. */
  private readonly configuredNetwork: SandboxNetwork
  private readonly networkFile: string | undefined
  /** The saved file's last read, keyed by its modification time and size. */
  private savedNetwork: { stamp: string; network: SandboxNetwork | undefined } | undefined
  /** The secret files hidden in every confined mode, or undefined when `protectSecrets` is off. */
  readonly readDeny: SandboxReadDeny | undefined
  private readonly cloudLoginsFile: string | undefined
  /** The cloud logins file's last read, keyed by its modification time and size. */
  private savedCloudLogins: { stamp: string; logins: readonly CloudLogin[] } | undefined
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())
    this.configuredNetwork = networkOf(config.network ?? 'on', config.allowedHosts ?? [])
    if (config.networkFile !== undefined && !isAbsolute(config.networkFile)) throw new Error('sandbox-policy: networkFile must be an absolute path')
    this.networkFile = config.networkFile
    if (config.cloudLoginsFile !== undefined && !isAbsolute(config.cloudLoginsFile)) throw new Error('sandbox-policy: cloudLoginsFile must be an absolute path')
    this.cloudLoginsFile = config.cloudLoginsFile
    if (config.protectSecrets === true) {
      const home = homedir()
      this.readDeny = {
        paths: [...new Set([...SECRET_PATHS, ...config.protectedPaths ?? []].map(path => expandHome(path, home)))],
        except: SECRET_EXCEPTIONS.map(path => expandHome(path, home)),
        dotenvOutsideWorkspace: true,
      }
    }

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
          return renderPolicyContext(this.resolve({ session }), capped ? ceiling : undefined, this.readDenyCoverage())
            + renderCloudLoginsContext(this.readDeny === undefined ? [] : this.cloudLogins())
        },
      })
    })
  }

  /**
   * How completely the mounted sandbox backend hides secret files from commands; `none` when no backend is
   * mounted or it does not say, so the model is never told files are hidden where they are not.
   */
  private readDenyCoverage(): SandboxReadDenyCoverage {
    if (this.readDeny === undefined) return 'none'
    try {
      return (this.ctx.get('sandbox') as SandboxProvider | undefined)?.readDenyCoverage() ?? 'none'
    } catch {
      return 'none'
    }
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
    const network = this.network()
    const mode = ceiling !== undefined && MODE_WIDTH[ceiling.mode] < MODE_WIDTH[uncapped] ? ceiling.mode : uncapped
    return {
      mode,
      workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
      ...session === undefined ? {} : { sessionId: session.id },
      // Absent means `on`, so the common case resolves exactly as before network policy existed.
      ...network.mode === 'on' ? {} : { network },
      // Full access lifts confinement, and with it the hidden secret files.
      ...this.readDeny === undefined || mode === 'danger-full-access' ? {} : this.confinedSecrets(this.readDeny),
    }
  }

  /**
   * The hidden files and extra writable folders for a confined call: the exposed cloud logins leave the hidden
   * list and, where their folder exists, become writable.
   */
  private confinedSecrets(readDeny: SandboxReadDeny): Pick<SandboxExecutionPolicy, 'readDeny' | 'extraWritable'> {
    const logins = this.cloudLogins()
    if (logins.length === 0) return { readDeny }
    const home = homedir()
    const exposed = logins.map(login => expandHome(CLOUD_LOGINS[login].path, home))
    const writable = exposed.filter(path => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true)
    return {
      readDeny: { ...readDeny, paths: readDeny.paths.filter(path => !exposed.includes(path)) },
      ...writable.length === 0 ? {} : { extraWritable: writable },
    }
  }

  /**
   * The cloud logins exposed to confined commands, from the cloud logins file; none without one.
   * @returns the exposed logins, in {@link CLOUD_LOGINS} order.
   */
  cloudLogins(): readonly CloudLogin[] {
    if (this.cloudLoginsFile === undefined) return []
    let stamp: string
    try {
      const info = statSync(this.cloudLoginsFile)
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      // No saved choice yet: no login is exposed.
      return []
    }
    if (this.savedCloudLogins?.stamp !== stamp) {
      let logins: CloudLogin[] = []
      try {
        const saved = JSON.parse(readFileSync(this.cloudLoginsFile, 'utf8')) as { enabled?: unknown }
        const enabled = Array.isArray(saved.enabled) ? saved.enabled : []
        logins = (Object.keys(CLOUD_LOGINS) as CloudLogin[]).filter(login => enabled.includes(login))
      } catch (error) {
        this.ctx.logger.warn('sandbox-policy: cannot read %s (%s); no cloud login is exposed', this.cloudLoginsFile, error instanceof Error ? error.message : String(error))
      }
      this.savedCloudLogins = { stamp, logins }
    }
    return this.savedCloudLogins.logins
  }

  /**
   * The network policy in force: the saved file's when it holds a valid one, else the configured one.
   * @returns the network policy for confined commands.
   */
  network(): SandboxNetwork {
    if (this.networkFile === undefined) return this.configuredNetwork
    let stamp: string
    try {
      const info = statSync(this.networkFile)
      stamp = `${info.mtimeMs}:${info.size}`
    } catch {
      // No saved choice yet: the configured policy applies.
      return this.configuredNetwork
    }
    if (this.savedNetwork?.stamp !== stamp) {
      let network: SandboxNetwork | undefined
      try {
        const saved = JSON.parse(readFileSync(this.networkFile, 'utf8')) as { network?: unknown; allowedHosts?: unknown }
        const mode = NETWORK_MODES.find(m => m === saved.network)
        if (mode !== undefined) network = networkOf(mode, Array.isArray(saved.allowedHosts) ? saved.allowedHosts : [])
        else this.ctx.logger.warn('sandbox-policy: %s has no valid "network"; using the configured network policy', this.networkFile)
      } catch (error) {
        this.ctx.logger.warn('sandbox-policy: cannot read %s (%s); using the configured network policy', this.networkFile, error instanceof Error ? error.message : String(error))
      }
      this.savedNetwork = { stamp, network }
    }
    return this.savedNetwork.network ?? this.configuredNetwork
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

/** Build the network policy for a mode and its host entries. */
function networkOf(mode: SandboxNetwork['mode'], hosts: readonly unknown[]): SandboxNetwork {
  return mode === 'allowlist' ? { mode, hosts: normalizeHosts(hosts) } : { mode }
}

export default SandboxPolicyService
