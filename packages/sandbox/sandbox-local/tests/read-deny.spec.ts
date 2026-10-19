/**
 * Secret read-deny in the local backend's profile dialects: the SBPL rule order Seatbelt's last-match
 * evaluation depends on, and bwrap's masking mounts for the paths that exist.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fake home with a key directory (and an exception inside it), a credentials file, and a workspace. */
function home(): { dir: string; policy: SandboxPolicy } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-read-deny-')))
  roots.push(dir)
  mkdirSync(join(dir, '.ssh'))
  writeFileSync(join(dir, '.ssh', 'id_ed25519'), 'key')
  writeFileSync(join(dir, '.ssh', 'known_hosts'), 'hosts')
  writeFileSync(join(dir, '.netrc'), 'machine x')
  mkdirSync(join(dir, 'ws'))
  return {
    dir,
    policy: {
      mode: 'workspace-write',
      workspaceRoot: join(dir, 'ws'),
      readDeny: {
        paths: [join(dir, '.ssh'), join(dir, '.netrc'), join(dir, '.aws')],
        except: [join(dir, '.ssh', 'known_hosts'), join(dir, '.ssh', 'config')],
        dotenvOutsideWorkspace: true,
      },
    },
  }
}

describe('seatbelt read-deny', () => {
  it('denies dotenv files, re-allows the workspace, denies the listed paths, then allows the exceptions, in that order', () => {
    const { dir, policy } = home()
    const profile = seatbeltProfileArgs(policy)[1] as string
    const dotenv = String.raw`(deny file-read-data (regex #"/\.env(\.[^/]+)?$"))`
    const workspace = `(allow file-read-data (subpath "${dir}/ws"))`
    const listed = `(deny file-read-data (subpath "${dir}/.ssh") (subpath "${dir}/.netrc") (subpath "${dir}/.aws"))`
    const except = `(allow file-read-data (subpath "${dir}/.ssh/known_hosts") (subpath "${dir}/.ssh/config"))`
    const at = [dotenv, workspace, listed, except].map(form => profile.indexOf(form))
    expect(at.every(index => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(profile.endsWith(except)).toBe(true)
  })

  it('keeps reads out of the profile without a read-deny, and skips the dotenv rules when they are off', () => {
    const { policy } = home()
    expect(seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: policy.workspaceRoot })[1]).not.toContain('file-read')
    const profile = seatbeltProfileArgs({ ...policy, readDeny: { ...policy.readDeny!, dotenvOutsideWorkspace: false } })[1] as string
    expect(profile).not.toContain('regex')
    expect(profile).toContain('(deny file-read-data (subpath')
  })

  it('applies under read-only too', () => {
    const { policy } = home()
    expect(seatbeltProfileArgs({ ...policy, mode: 'read-only' })[1]).toContain('(deny file-read-data (subpath')
  })
})

describe('bwrap read-deny', () => {
  it('masks an existing directory with an empty tmpfs and binds its existing exceptions back, and a file with /dev/null', () => {
    const { dir, policy } = home()
    const args = bwrapProfileArgs(policy)
    const tail = args.slice(args.lastIndexOf(policy.workspaceRoot) + 1)
    expect(tail).toEqual([
      '--tmpfs', `${dir}/.ssh`,
      '--ro-bind', `${dir}/.ssh/known_hosts`, `${dir}/.ssh/known_hosts`,
      '--ro-bind', '/dev/null', `${dir}/.netrc`,
    ])
  })

  it('skips paths that do not exist, and masks inside a workspace that contains them', () => {
    const { dir, policy } = home()
    const args = bwrapProfileArgs({ ...policy, workspaceRoot: dir })
    expect(args).not.toContain(`${dir}/.aws`)
    expect(args.indexOf(`${dir}/.ssh`)).toBeGreaterThan(args.lastIndexOf(dir))
  })

  it('adds no mounts without a read-deny, and Landlock does not apply one', () => {
    const { policy } = home()
    const plain = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: policy.workspaceRoot })
    expect(plain).not.toContain('/dev/null')
    expect(landlockProfileArgs(policy)).toEqual(landlockProfileArgs({ mode: 'workspace-write', workspaceRoot: policy.workspaceRoot }))
  })
})

describe('read-deny coverage', () => {
  async function coverage(internals: LocalSandboxProvider['internals'], config: Record<string, unknown> = {}) {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, config)
    const sandbox = ctx.sandbox as LocalSandboxProvider
    sandbox.internals = internals
    try {
      return sandbox.readDenyCoverage()
    } finally {
      await ctx.fiber.dispose()
    }
  }

  it('reports what each runner hides from commands, so the model is told the truth', async () => {
    expect(await coverage({ platform: 'darwin' })).toBe('full')
    expect(await coverage({ platform: 'linux', probeBwrap: () => true })).toBe('listed')
    expect(await coverage({ platform: 'linux', probeBwrap: () => false, probeLandlock: () => 'full', landlockLauncher: '/fake/landlock-run' })).toBe('none')
    expect(await coverage({ chain: [] })).toBe('none')
    expect(await coverage({}, { runnerCommand: ['/opt/runner'], runnerFailureSignatures: ['runner:'] })).toBe('listed')
  })
})
