/**
 * The read-deny meaning shared by every enforcement layer: which paths a
 * {@link SandboxReadDeny} hides. Seatbelt expresses it as SBPL rules, bwrap as
 * masking mounts, and the agent's in-process file tools check it here, so the
 * read tool cannot see a file a command cannot.
 *
 * @module dsh-sandbox/secrets
 */

import { basename, sep } from 'node:path'
import type { SandboxExecutionPolicy, SandboxReadDeny } from './index.ts'
import { canonicalPath } from './roots.ts'

/** A dotenv file name: `.env` or `.env.<anything>`, such as `.env.local`. */
export const DOTENV_NAME = /^\.env(\..+)?$/

/**
 * Whether `path` equals `root` or lies beneath it. Both must be canonical.
 * @param path - the canonical path to test.
 * @param root - the canonical root.
 * @returns true when `path` is `root` or a descendant of it.
 */
export function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * The read-deny as the enforcement layers compare it: every path canonical (Seatbelt and the file tools match
 * resolved paths), and any listed path that contains the workspace root dropped, so a workspace chosen inside
 * a hidden directory stays usable.
 * @param policy - the resolved policy.
 * @returns the canonical read-deny, or undefined when the policy hides nothing.
 */
export function canonicalReadDeny(policy: Pick<SandboxExecutionPolicy, 'readDeny' | 'workspaceRoot'>): SandboxReadDeny | undefined {
  const deny = policy.readDeny
  if (deny === undefined) return undefined
  const workspace = canonicalPath(policy.workspaceRoot)
  const unique = (paths: readonly string[]) => [...new Set(paths.map(canonicalPath))]
  return {
    paths: unique(deny.paths).filter(path => !isUnder(workspace, path)),
    except: unique(deny.except),
    dotenvOutsideWorkspace: deny.dotenvOutsideWorkspace,
  }
}

/**
 * Whether a policy's read-deny hides one path. An exception always wins; a listed path is hidden wherever it
 * is, inside the workspace or not; a dotenv file is hidden only outside the workspace root.
 * @param path - the canonical (symlink-resolved) absolute path about to be read.
 * @param policy - the resolved policy; no `readDeny` hides nothing.
 * @returns true when the read must be refused.
 */
export function readDenied(path: string, policy: Pick<SandboxExecutionPolicy, 'readDeny' | 'workspaceRoot'>): boolean {
  const deny = canonicalReadDeny(policy)
  if (deny === undefined) return false
  if (deny.except.some(allowed => isUnder(path, allowed))) return false
  if (deny.paths.some(hidden => isUnder(path, hidden))) return true
  return deny.dotenvOutsideWorkspace && DOTENV_NAME.test(basename(path)) && !isUnder(path, canonicalPath(policy.workspaceRoot))
}
