/**
 * Tests for the read-deny meaning every enforcement layer shares: which paths a policy hides, with symlinks
 * resolved, exceptions winning, and dotenv files hidden only outside the workspace.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, canonicalReadDeny, isUnder, readDenied } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fake home with a key directory, a credentials file and two projects, canonical. */
function home() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-secrets-')))
  roots.push(dir)
  mkdirSync(join(dir, '.ssh'))
  writeFileSync(join(dir, '.ssh', 'id_ed25519'), 'key')
  writeFileSync(join(dir, '.ssh', 'known_hosts'), 'hosts')
  writeFileSync(join(dir, '.netrc'), 'machine x')
  mkdirSync(join(dir, 'ws'))
  mkdirSync(join(dir, 'other'))
  const policy: SandboxExecutionPolicy = {
    mode: 'workspace-write',
    workspaceRoot: join(dir, 'ws'),
    readDeny: { paths: [join(dir, '.ssh'), join(dir, '.netrc')], except: [join(dir, '.ssh', 'known_hosts')], dotenvOutsideWorkspace: true },
  }
  return { dir, policy }
}

describe('readDenied', () => {
  it('hides listed paths and their contents, keeps exceptions, and leaves everything else readable', () => {
    const { dir, policy } = home()
    expect(readDenied(join(dir, '.ssh'), policy)).toBe(true)
    expect(readDenied(join(dir, '.ssh', 'id_ed25519'), policy)).toBe(true)
    expect(readDenied(join(dir, '.ssh', 'known_hosts'), policy)).toBe(false)
    expect(readDenied(join(dir, '.netrc'), policy)).toBe(true)
    expect(readDenied(join(dir, '.netrc-old'), policy)).toBe(false)
    expect(readDenied(join(dir, '.sshrc'), policy)).toBe(false)
    expect(readDenied(join(dir, 'other', 'main.ts'), policy)).toBe(false)
  })

  it('hides dotenv files outside the workspace only', () => {
    const { dir, policy } = home()
    expect(readDenied(join(dir, 'other', '.env'), policy)).toBe(true)
    expect(readDenied(join(dir, 'other', '.env.production'), policy)).toBe(true)
    expect(readDenied(join(dir, 'ws', '.env'), policy)).toBe(false)
    expect(readDenied(join(dir, 'ws', 'app', '.env.local'), policy)).toBe(false)
    expect(readDenied(join(dir, 'other', 'env'), policy)).toBe(false)
    expect(readDenied(join(dir, 'other', '.envrc'), policy)).toBe(false)
    expect(readDenied(join(dir, 'other', '.env'), { ...policy, readDeny: { ...policy.readDeny!, dotenvOutsideWorkspace: false } })).toBe(false)
  })

  it('hides nothing without a read-deny', () => {
    const { dir, policy } = home()
    expect(readDenied(join(dir, '.ssh', 'id_ed25519'), { workspaceRoot: policy.workspaceRoot })).toBe(false)
  })

  it('compares symlinked list entries by their targets', () => {
    const { dir, policy } = home()
    const real = join(dir, 'dotfiles-aws')
    mkdirSync(real)
    symlinkSync(real, join(dir, '.aws'))
    const linked = { ...policy, readDeny: { ...policy.readDeny!, paths: [join(dir, '.aws')] } }
    expect(readDenied(join(real, 'credentials'), linked)).toBe(true)
  })
})

describe('canonicalReadDeny', () => {
  it('drops a listed path that contains the workspace, so a workspace chosen inside it stays usable', () => {
    const { dir, policy } = home()
    const inside = { ...policy, workspaceRoot: join(dir, '.ssh') }
    expect(canonicalReadDeny(inside)?.paths).toEqual([join(dir, '.netrc')])
    expect(readDenied(join(dir, '.ssh', 'id_ed25519'), inside)).toBe(false)
  })

  it('keeps a listed path inside the workspace: secrets stay hidden even when the workspace is home', () => {
    const { dir, policy } = home()
    expect(readDenied(join(dir, '.ssh', 'id_ed25519'), { ...policy, workspaceRoot: dir })).toBe(true)
  })

  it('returns undefined without a read-deny and deduplicates spellings', () => {
    const { dir, policy } = home()
    expect(canonicalReadDeny({ workspaceRoot: dir })).toBeUndefined()
    const doubled = canonicalReadDeny({ ...policy, readDeny: { ...policy.readDeny!, paths: [join(dir, '.ssh'), join(dir, 'ws', '..', '.ssh')] } })
    expect(doubled?.paths).toEqual([canonicalPath(join(dir, '.ssh'))])
  })
})

describe('isUnder', () => {
  it('matches the root itself and descendants, never a sibling sharing a prefix', () => {
    expect(isUnder('/a/b', '/a/b')).toBe(true)
    expect(isUnder('/a/b/c', '/a/b')).toBe(true)
    expect(isUnder('/a/bc', '/a/b')).toBe(false)
    expect(isUnder('/a/b', '/')).toBe(true)
  })
})
