/**
 * Tests for the sandbox-policy home: the deployment default (mode +
 * workspaceRoot) the service exposes, and the per-session `sandbox/mode`
 * override kit (fold + write path) every enforcing capability reads.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService, { CLOUD_LOGINS, SANDBOX_MODES, SECRET_EXCEPTIONS, SECRET_PATHS, normalizeHosts, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { NETWORK_LEAKS } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxReadDenyCoverage } from '@deepseek-ai/dsh-sandbox'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'

async function mounted(config: { mode?: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot?: string } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, config)
  return ctx
}

function session(id: string, cwd?: string, parent?: Session): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    ...cwd === undefined ? {} : { cwd },
    ...parent === undefined ? {} : { parentSession: parent.id },
  })
}

function agentFor(activeSession: Session): Agent {
  return { session: activeSession } as Agent
}

async function policyContext(ctx: Context, activeSession: Session): Promise<string | undefined> {
  return (await ctx.systemPrompt.assemble({ agent: agentFor(activeSession) }))
    .contexts.find(context => context.name === 'sandbox:policy')?.text
}

describe('SandboxPolicyService', () => {
  it('defaults to read-only under the process cwd', async () => {
    const ctx = await mounted()
    expect(ctx.sandboxPolicy.defaultMode).toBe('read-only')
    expect(ctx.sandboxPolicy.workspaceRoot).toBe(resolve(process.cwd()))
  })

  it('preserves an absolute execution-world root without host path normalization', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/ws/../ws/./sub' })
    expect(ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
    expect(ctx.sandboxPolicy.workspaceRoot).toBe('/ws/../ws/./sub')
  })

  it('rejects a relative deployment workspace root at load', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await expect(ctx.plugin(SandboxPolicyService, { workspaceRoot: 'relative/workspace' }))
        .rejects.toThrow('sandbox-policy: workspace root must be an absolute execution-world path')
      expect(ctx.get('sandboxPolicy')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves the deployment policy for an agentless call', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback' })
    expect(ctx.sandboxPolicy.resolve()).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/fallback',
    })
  })

  it('resolves each session mode and cwd together without changing the fallback', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback' })
    const first = session('sess-first', '/projects/first')
    const second = session('sess-second', '/projects/second')
    setSandboxMode(second, 'read-only')

    expect(ctx.sandboxPolicy.resolve({ session: first })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/projects/first',
      sessionId: 'sess-first',
    })
    expect(ctx.sandboxPolicy.resolve({ session: second })).toEqual({
      mode: 'read-only',
      workspaceRoot: '/projects/second',
      sessionId: 'sess-second',
    })
    expect(ctx.sandboxPolicy.overrideOf(first)).toBeUndefined()
    expect(ctx.sandboxPolicy.overrideOf(second)).toBe('read-only')
    expect(ctx.sandboxPolicy.resolve()).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/fallback',
    })
  })

  it.skipIf(process.platform === 'win32')('preserves symlink-sensitive session cwd for its enforcing provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-policy-cwd-'))
    try {
      const lexical = join(root, 'lexical')
      const physical = join(root, 'physical')
      const child = join(physical, 'child')
      mkdirSync(lexical)
      mkdirSync(child, { recursive: true })
      const link = join(lexical, 'link')
      symlinkSync(child, link, 'dir')
      const cwd = `${link}${sep}..`
      const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback' })

      expect(ctx.sandboxPolicy.resolve({ session: session('sess-symlink-parent', cwd) })).toEqual({
        mode: 'workspace-write',
        workspaceRoot: cwd,
        sessionId: 'sess-symlink-parent',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets an approved mode outrank the session mode while retaining its root', async () => {
    const ctx = await mounted({ workspaceRoot: '/fallback' })
    const active = session('sess-approved', '/projects/approved')
    setSandboxMode(active, 'read-only')
    expect(ctx.sandboxPolicy.resolve({ session: active, mode: 'danger-full-access' })).toEqual({
      mode: 'danger-full-access',
      workspaceRoot: '/projects/approved',
      sessionId: 'sess-approved',
    })
  })

  it('uses the configured root when a session has no cwd', async () => {
    const ctx = await mounted({ workspaceRoot: '/fallback' })
    expect(ctx.sandboxPolicy.resolve({ session: session('sess-no-cwd') }).workspaceRoot).toBe('/fallback')
  })

  it('rejects a mode outside the closed vocabulary at load', async () => {
    const ctx = new Context()
    // Config validation runs when the fiber activates, and the policy seam
    // requires the projection registry (mandatory injection) to activate.
    await ctx.plugin(SessionProjectionRegistry)
    // schemastery rejects the union violation when the plugin loads.
    await expect(ctx.plugin(SandboxPolicyService, { mode: 'yolo' as never })).rejects.toThrow()
  })

  it('disposes the service and context contribution from a child fiber (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(SandboxPolicyService, {})
    expect(ctx.sandboxPolicy).toBeDefined()
    expect(await policyContext(ctx, session('sess-hmr'))).toContain('read-only')
    await fiber.dispose()
    expect(ctx.get('sandboxPolicy')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).contexts.find(context => context.name === 'sandbox:policy')).toBeUndefined()
  })
})

describe('sandbox:policy request context', () => {
  async function promptMounted(config: { mode?: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot?: string } = {}): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, config)
    return ctx
  }

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('renders the exact %s policy without a capability inventory', async (mode) => {
    const ctx = await promptMounted({ mode, workspaceRoot: '/fallback' })
    const workspaceRoot = '/projects/../projects/current'
    const expected = {
      'read-only': 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.',
      'workspace-write': `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(workspaceRoot)}. Some platform temporary areas may also be writable.`,
      'danger-full-access': 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.',
    } as const

    expect(await policyContext(ctx, session(`sess-${mode}`, '/projects/../projects/current'))).toBe(expected[mode])
  })

  it('keeps the complete rendered prompt byte-stable across TMPDIR changes', async () => {
    const ctx = await promptMounted({ mode: 'workspace-write' })
    const active = session('sess-tmpdir-stability', '/projects/current')
    const previous = process.env.TMPDIR
    try {
      process.env.TMPDIR = '/tmp/first-host-temp'
      const firstAssembly = await ctx.systemPrompt.assemble({ agent: agentFor(active) })
      const firstPrompt = renderPrompt(firstAssembly)
      const firstContext = renderContextSnapshot(firstAssembly)
      process.env.TMPDIR = '/tmp/second-host-temp'
      const secondAssembly = await ctx.systemPrompt.assemble({ agent: agentFor(active) })
      expect(renderPrompt(secondAssembly)).toBe(firstPrompt)
      expect(renderContextSnapshot(secondAssembly)).toBe(firstContext)
      expect(firstContext).not.toContain('host-temp')
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  })

  it('reflects the latest durable switch on the next assembly and stays byte-stable otherwise', async () => {
    const ctx = await promptMounted()
    const active = session('sess-switch', '/projects/current')
    const first = await policyContext(ctx, active)
    expect(await policyContext(ctx, active)).toBe(first)

    setSandboxMode(active, 'danger-full-access')
    const danger = await policyContext(ctx, active)
    expect(danger).toBe('Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.')
    expect(await policyContext(ctx, active)).toBe(danger)

    setSandboxMode(active, 'workspace-write')
    expect(await policyContext(ctx, active)).toBe(`Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify('/projects/current')}. Some platform temporary areas may also be writable.`)
  })

  it('reconstructs resumed policy from the session log and omits diagnostics without an agent', async () => {
    const active = session('sess-resume', '/projects/current')
    setSandboxMode(active, 'workspace-write')
    const resumed = Session.create(active.id, active.snapshotEvents(), active.header)
    const ctx = await promptMounted({ mode: 'read-only' })

    expect(await policyContext(ctx, resumed)).toContain('workspace-write')
    expect((await ctx.systemPrompt.assemble()).contexts.find(context => context.name === 'sandbox:policy')?.text).toBe('')
  })
})

describe('ceilings', () => {
  async function promptMounted(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: '/fallback' })
    return ctx
  }

  it('caps the session mode, the session override and an approved escalation, for that session only', async () => {
    const ctx = await promptMounted('danger-full-access')
    const planning = session('sess-planning', '/projects/a')
    const other = session('sess-other', '/projects/b')
    ctx.sandboxPolicy.limit(target => (target === planning ? { mode: 'read-only', reason: 'plan mode is on' } : undefined))
    expect(ctx.sandboxPolicy.resolve({ session: planning }).mode).toBe('read-only')
    expect(ctx.sandboxPolicy.resolve({ session: planning, mode: 'workspace-write' }).mode).toBe('read-only')
    setSandboxMode(planning, 'workspace-write')
    expect(ctx.sandboxPolicy.resolve({ session: planning }).mode).toBe('read-only')
    expect(ctx.sandboxPolicy.resolve({ session: other }).mode).toBe('danger-full-access')
    expect(ctx.sandboxPolicy.resolve().mode).toBe('danger-full-access')
  })

  it('holds subagents and workflow children of a held session, however deep, through the agents service', async () => {
    const ctx = await promptMounted('workspace-write')
    const planning = session('sess-plan-parent', '/projects/a')
    const child = session('sess-plan-child', '/projects/a', planning)
    const grandchild = session('sess-plan-grandchild', '/projects/a', child)
    const unrelated = session('sess-plan-unrelated', '/projects/a')
    const live = new Map([planning, child, grandchild].map(s => [s.id, { session: s }]))
    ctx.provide('agents', { get: (id: string) => live.get(id as never) } as never)
    let held = true
    ctx.sandboxPolicy.limit(target => (held && target === planning ? { mode: 'read-only', reason: 'plan mode is on' } : undefined))
    expect(ctx.sandboxPolicy.resolve({ session: child }).mode).toBe('read-only')
    expect(ctx.sandboxPolicy.resolve({ session: grandchild, mode: 'danger-full-access' }).mode).toBe('read-only')
    expect(await policyContext(ctx, grandchild)).toContain('read-only because plan mode is on')
    expect(ctx.sandboxPolicy.resolve({ session: unrelated }).mode).toBe('workspace-write')
    held = false
    expect(ctx.sandboxPolicy.resolve({ session: grandchild }).mode).toBe('workspace-write')
    // A parent that is no longer live ends the walk instead of failing.
    held = true
    live.delete(child.id)
    expect(ctx.sandboxPolicy.resolve({ session: grandchild }).mode).toBe('workspace-write')
  })

  it('applies the narrowest ceiling and never widens a narrower mode', async () => {
    const ctx = await promptMounted('read-only')
    const target = session('sess-narrow', '/projects/a')
    ctx.sandboxPolicy.limit(() => ({ mode: 'workspace-write', reason: 'wide' }))
    expect(ctx.sandboxPolicy.resolve({ session: target }).mode).toBe('read-only')
    expect(ctx.sandboxPolicy.resolve({ session: target, mode: 'danger-full-access' }).mode).toBe('workspace-write')
    ctx.sandboxPolicy.limit(() => ({ mode: 'read-only', reason: 'narrow' }))
    expect(ctx.sandboxPolicy.ceilingOf(target)).toEqual({ mode: 'read-only', reason: 'narrow' })
    expect(ctx.sandboxPolicy.resolve({ session: target, mode: 'danger-full-access' }).mode).toBe('read-only')
  })

  it('tells the model why the session is held, and stops when the source is removed', async () => {
    const ctx = await promptMounted('workspace-write')
    const target = session('sess-told', '/projects/a')
    const remove = ctx.sandboxPolicy.limit(() => ({ mode: 'read-only', reason: 'plan mode is on' }))
    expect(await policyContext(ctx, target)).toBe('Current DSH file policy: read-only because plan mode is on. Operations enforced by the DSH file sandbox cannot widen past read-only until that changes, and a sandbox escalation cannot lift it, so do not request one.')
    remove()
    expect(ctx.sandboxPolicy.resolve({ session: target }).mode).toBe('workspace-write')
    expect(await policyContext(ctx, target)).toContain('Current DSH file policy: workspace-write.')
  })

  it('keeps the ordinary text when the ceiling does not narrow the mode', async () => {
    const ctx = await promptMounted('read-only')
    ctx.sandboxPolicy.limit(() => ({ mode: 'read-only', reason: 'plan mode is on' }))
    expect(await policyContext(ctx, session('sess-same', '/projects/a'))).toMatch(/^Current DSH file policy: read-only\. Any available operation/)
  })
})

describe('network policy', () => {
  async function withNetwork(config: Record<string, unknown>): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/fallback', ...config })
    return ctx
  }

  it('leaves network out of the resolved policy when it is on (the default)', async () => {
    const ctx = await withNetwork({})
    expect(ctx.sandboxPolicy.resolve()).toEqual({ mode: 'workspace-write', workspaceRoot: '/fallback' })
    expect(await policyContext(ctx, session('sess-net-on', '/p'))).not.toContain('Network')
  })

  it('resolves off and allowlist, normalizing host entries', async () => {
    expect((await withNetwork({ network: 'off' })).sandboxPolicy.resolve().network).toEqual({ mode: 'off' })
    const ctx = await withNetwork({ network: 'allowlist', allowedHosts: ['https://Registry.npmjs.org/', '*.GitHub.com', 'pypi.org:443', 'not a host', 'pypi.org'] })
    expect(ctx.sandboxPolicy.resolve().network).toEqual({ mode: 'allowlist', hosts: ['registry.npmjs.org', '*.github.com', 'pypi.org'] })
    expect(normalizeHosts(['', 7, 'a..b', '-x.com', 'ok.io'])).toEqual(['ok.io'])
  })

  it('tells the model what the network policy allows, and drops the escalation hint while a ceiling holds', async () => {
    const off = await withNetwork({ network: 'off' })
    const target = session('sess-net-off', '/p')
    const leaks = NETWORK_LEAKS[process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'other']
    expect(await policyContext(off, target)).toContain(`Network for commands: off. Direct connections to other computers are blocked, so downloads, package installs and git fetches normally fail. ${leaks} Do not use them to get around this setting. A command that needs more network access can be retried once with sandbox_permissions danger-full-access, which the user must approve.`)
    // Honest about what stays reachable: it never claims commands cannot connect at all.
    expect(await policyContext(off, target)).not.toContain('cannot connect to other computers')
    expect(NETWORK_LEAKS.darwin).toMatch(/local proxies and SSH tunnels .* can still be reached/)
    expect(NETWORK_LEAKS.darwin).toContain('open')
    expect(NETWORK_LEAKS.linux).toMatch(/Docker socket.*D-Bus.*systemd-run/)
    off.sandboxPolicy.limit(() => ({ mode: 'read-only', reason: 'plan mode is on' }))
    const held = await policyContext(off, target)
    expect(held).toContain('Network for commands: off.')
    expect(held).not.toContain('retried once')
    const list = await withNetwork({ network: 'allowlist', allowedHosts: ['pypi.org'] })
    expect(await policyContext(list, session('sess-net-list', '/p'))).toContain(`Network for commands: only pypi.org, through a proxy set in HTTP_PROXY and HTTPS_PROXY; other hosts are refused with HTTP 403, and direct connections are blocked, so programs that ignore those variables cannot connect directly. ${leaks}`)
    setSandboxMode(target, 'danger-full-access')
    const full = await withNetwork({ network: 'off' })
    expect(await policyContext(full, target)).not.toContain('Network')
  })

  it('reads the saved choice from networkFile, follows its changes, and falls back when it is missing or invalid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-net-'))
    try {
      const file = join(dir, 'network.json')
      const ctx = await withNetwork({ network: 'off', networkFile: file })
      expect(ctx.sandboxPolicy.network()).toEqual({ mode: 'off' })
      writeFileSync(file, JSON.stringify({ network: 'allowlist', allowedHosts: ['github.com'] }))
      expect(ctx.sandboxPolicy.network()).toEqual({ mode: 'allowlist', hosts: ['github.com'] })
      writeFileSync(file, JSON.stringify({ network: 'on', note: 'changed size' }))
      expect(ctx.sandboxPolicy.network()).toEqual({ mode: 'on' })
      writeFileSync(file, '{ not json')
      expect(ctx.sandboxPolicy.network()).toEqual({ mode: 'off' })
      writeFileSync(file, JSON.stringify({ network: 'sideways' }))
      expect(ctx.sandboxPolicy.network()).toEqual({ mode: 'off' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a relative networkFile at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await expect(ctx.plugin(SandboxPolicyService, { networkFile: 'network.json' })).rejects.toThrow('networkFile must be an absolute path')
    await ctx.fiber.dispose()
  })
})

describe('secret protection', () => {
  /** A sandbox backend reporting a fixed read-deny coverage, as Seatbelt (`full`), bwrap (`listed`) or Landlock (`none`) would. */
  function sandboxWith(coverage: SandboxReadDenyCoverage) {
    return class extends SandboxProvider {
      confine(argv: readonly string[]): Promise<ConfinedArgv> { return Promise.resolve({ argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }) }
      override readDenyCoverage(): SandboxReadDenyCoverage { return coverage }
    }
  }

  async function withSecrets(config: Record<string, unknown>, coverage: SandboxReadDenyCoverage | 'unmounted' = 'full'): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    if (coverage !== 'unmounted') await ctx.plugin(sandboxWith(coverage))
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/fallback', protectSecrets: true, ...config })
    return ctx
  }

  it('hides nothing unless protectSecrets is on', async () => {
    const ctx = await withSecrets({ protectSecrets: undefined })
    expect(ctx.sandboxPolicy.resolve().readDeny).toBeUndefined()
    expect(await policyContext(ctx, session('sess-sec-off', '/p'))).not.toContain('Secret files')
  })

  it('resolves the well-known secret paths under the home directory, plus protectedPaths', async () => {
    const ctx = await withSecrets({ protectedPaths: ['/opt/harness/.credentials.yaml', '~/.kube/config'] })
    const deny = ctx.sandboxPolicy.resolve().readDeny
    expect(deny?.paths).toEqual([...SECRET_PATHS.map(path => join(homedir(), path.slice(2))), '/opt/harness/.credentials.yaml', join(homedir(), '.kube/config')])
    expect(deny?.paths).toContain(join(homedir(), '.ssh'))
    expect(deny?.paths).toContain(join(homedir(), '.docker/config.json'))
    expect(deny?.except).toEqual(SECRET_EXCEPTIONS.map(path => join(homedir(), path.slice(2))))
    expect(deny?.dotenvOutsideWorkspace).toBe(true)
  })

  it('applies in read-only and workspace-write but not under full access', async () => {
    const ctx = await withSecrets({})
    expect(ctx.sandboxPolicy.resolve({ mode: 'read-only' }).readDeny).toBeDefined()
    expect(ctx.sandboxPolicy.resolve({ mode: 'danger-full-access' }).readDeny).toBeUndefined()
  })

  it('hides database logins kept in single files and exposes them readable only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    const previous = process.env['HOME']
    process.env['HOME'] = home
    try {
      writeFileSync(join(home, '.pgpass'), 'db:5432:*:me:secret\n')
      writeFileSync(join(home, '.databrickscfg'), '[DEFAULT]\n')
      mkdirSync(join(home, '.databricks'))
      const file = join(home, 'cloud-logins.json')
      const ctx = await withSecrets({ cloudLoginsFile: file })
      for (const path of ['.pgpass', '.pg_service.conf', '.my.cnf', '.mylogin.cnf', '.databrickscfg', '.databricks', '.snowflake']) {
        expect(ctx.sandboxPolicy.resolve().readDeny?.paths).toContain(join(home, path))
      }
      writeFileSync(file, JSON.stringify({ enabled: ['postgres', 'databricks'] }))
      const policy = ctx.sandboxPolicy.resolve()
      expect(policy.readDeny?.paths).not.toContain(join(home, '.pgpass'))
      expect(policy.readDeny?.paths).not.toContain(join(home, '.pg_service.conf'))
      expect(policy.readDeny?.paths).not.toContain(join(home, '.databrickscfg'))
      expect(policy.readDeny?.paths).toContain(join(home, '.my.cnf'))
      // Only existing folders become writable; single files stay read-only.
      expect(policy.extraWritable).toEqual([join(home, '.databricks')])
      expect(await policyContext(ctx, session('sess-db', '/p'))).toContain(`${CLOUD_LOGINS.databricks.label}, ${CLOUD_LOGINS.postgres.label}.`)
    } finally {
      process.env['HOME'] = previous
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('exposes the cloud logins named in the cloud logins file: readable, and writable where the folder exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    const previous = process.env['HOME']
    process.env['HOME'] = home
    try {
      mkdirSync(join(home, '.config', 'gcloud'), { recursive: true })
      const file = join(home, 'cloud-logins.json')
      const ctx = await withSecrets({ cloudLoginsFile: file })
      expect(ctx.sandboxPolicy.cloudLogins()).toEqual([])
      expect(ctx.sandboxPolicy.resolve().readDeny?.paths).toContain(join(home, '.config', 'gcloud'))
      expect(ctx.sandboxPolicy.resolve().extraWritable).toBeUndefined()
      writeFileSync(file, JSON.stringify({ enabled: ['kubernetes', 'gcloud', 'bogus'] }))
      expect(ctx.sandboxPolicy.cloudLogins()).toEqual(['gcloud', 'kubernetes'])
      const policy = ctx.sandboxPolicy.resolve()
      expect(policy.readDeny?.paths).not.toContain(join(home, '.config', 'gcloud'))
      expect(policy.readDeny?.paths).not.toContain(join(home, '.kube'))
      expect(policy.readDeny?.paths).toContain(join(home, '.aws'))
      expect(policy.extraWritable).toEqual([join(home, '.config', 'gcloud')])
      expect(ctx.sandboxPolicy.resolve({ mode: 'danger-full-access' }).extraWritable).toBeUndefined()
      expect(await policyContext(ctx, session('sess-cloud', '/p'))).toContain(
        `available to commands: ${CLOUD_LOGINS.gcloud.label}, ${CLOUD_LOGINS.kubernetes.label}.`)
      writeFileSync(file, '{ not json')
      expect(ctx.sandboxPolicy.cloudLogins()).toEqual([])
      writeFileSync(file, JSON.stringify({ enabled: 'aws' }))
      expect(ctx.sandboxPolicy.cloudLogins()).toEqual([])
      expect(await policyContext(ctx, session('sess-cloud-off', '/p'))).not.toContain('command-line logins available')
      await expect(withSecrets({ cloudLoginsFile: 'relative.json' })).rejects.toThrow(/cloudLoginsFile must be an absolute path/)
      const unprotected = await withSecrets({ protectSecrets: false, cloudLoginsFile: file })
      writeFileSync(file, JSON.stringify({ enabled: ['gcloud'] }))
      expect(await policyContext(unprotected, session('sess-cloud-open', '/p'))).not.toContain('command-line logins available')
    } finally {
      process.env['HOME'] = previous
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects a relative protected path at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await expect(ctx.plugin(SandboxPolicyService, { protectSecrets: true, protectedPaths: ['secrets.txt'] })).rejects.toThrow('must be absolute or start with ~/')
    await ctx.fiber.dispose()
  })

  it('tells the model which files are hidden, and drops the escalation hint while a ceiling holds', async () => {
    const ctx = await withSecrets({})
    const target = session('sess-sec-on', '/p')
    const text = await policyContext(ctx, target)
    expect(text).toContain('Secret files are hidden from commands and file tools: ~/.ssh, ~/.aws, ~/.config/gcloud, ~/.azure, ~/.kube, ~/.netrc, ~/.git-credentials, ~/.npmrc, ~/.docker/config.json, ~/.env, ~/.snowflake, ~/Library/Application Support/snowflake, ~/.config/snowflake, ~/.databrickscfg, ~/.databricks, ~/.pgpass, ~/.pg_service.conf, ~/.my.cnf, ~/.mylogin.cnf (except ~/.ssh/known_hosts, ~/.ssh/config), and .env files outside the workspace.')
    expect(text).toContain('retried once with sandbox_permissions danger-full-access')
    ctx.sandboxPolicy.limit(() => ({ mode: 'read-only', reason: 'plan mode is on' }))
    const held = await policyContext(ctx, target)
    expect(held).toContain('Secret files are hidden')
    expect(held).not.toContain('git over ssh')
    setSandboxMode(target, 'danger-full-access')
    const full = await withSecrets({})
    expect(await policyContext(full, target)).not.toContain('Secret files')
  })

  it('says dotenv files outside the workspace stay readable by commands where the backend masks only listed paths (bwrap)', async () => {
    const text = await policyContext(await withSecrets({}, 'listed'), session('sess-sec-bwrap', '/p'))
    expect(text).toContain('Secret files are hidden from commands and file tools: ~/.ssh, ~/.aws, ~/.config/gcloud, ~/.azure, ~/.kube, ~/.netrc, ~/.git-credentials, ~/.npmrc, ~/.docker/config.json, ~/.env, ~/.snowflake, ~/Library/Application Support/snowflake, ~/.config/snowflake, ~/.databrickscfg, ~/.databricks, ~/.pgpass, ~/.pg_service.conf, ~/.my.cnf, ~/.mylogin.cnf (except ~/.ssh/known_hosts, ~/.ssh/config); commands see an empty folder or an empty file in their place.')
    expect(text).toContain('.env files outside the workspace are hidden from the file tools only: commands on this computer can still read them')
    expect(text).not.toContain('Operation not permitted')
    expect(text).toContain('retried once with sandbox_permissions danger-full-access')
  })

  it('says commands can still read the files where the backend hides nothing (Landlock alone), or no backend says', async () => {
    for (const coverage of ['none', 'unmounted'] as const) {
      const text = await policyContext(await withSecrets({}, coverage), session(`sess-sec-${coverage}`, '/p'))
      expect(text).toContain('Secret files are hidden from the file tools only: ~/.ssh, ~/.aws')
      expect(text).toContain("This computer's sandbox cannot hide files from commands, so commands can still read them")
      expect(text).not.toContain('hidden from commands and file tools')
      expect(text).not.toContain('retried once with sandbox_permissions danger-full-access, which the user must approve.')
    }
  })
})

describe('the sandbox/mode session kit', () => {
  it('SANDBOX_MODES lists every mode for advertisement and validation', () => {
    expect(SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  it('the sandboxMode projection folds to the last switch, or null without one', async () => {
    const ctx = await mounted()
    const session = Session.create(SessionId('sess-fold'))
    expect(ctx.sessionProjections.stateOf(session, 'sandboxMode')).toBeNull()
    setSandboxMode(session, 'workspace-write')
    setSandboxMode(session, 'read-only')
    expect(ctx.sessionProjections.stateOf(session, 'sandboxMode')).toBe('read-only')
  })

  it('setSandboxMode appends exactly one sandbox/mode event per switch', () => {
    const session = Session.create(SessionId('sess-write'))
    setSandboxMode(session, 'danger-full-access')
    const modeEvents = session.snapshotEvents().filter(e => e.type === 'sandbox/mode')
    expect(modeEvents).toHaveLength(1)
    expect(modeEvents[0]?.data).toEqual({ mode: 'danger-full-access' })
  })
})
