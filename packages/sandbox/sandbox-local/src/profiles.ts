/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { statSync } from 'node:fs'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { canonicalPath, canonicalReadDeny, isUnder, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
    // Exposed cloud logins: bound writable like the workspace, so the CLIs can refresh their tokens.
    for (const path of policy.extraWritable ?? []) {
      if (statSync(path, { throwIfNoEntry: false })?.isDirectory() === true) args.push('--bind', path, path)
    }
  }
  // A network namespace of its own, with only loopback: no route to other hosts. Under `allowlist` the
  // proxy's Unix socket, outside /tmp and visible through the read-only root, is the only way out.
  if (limitsNetwork(policy)) args.push('--unshare-net')
  args.push(...bwrapReadDenyArgs(policy))
  return args
}

/**
 * Masking mounts for the policy's read-deny, after the workspace bind so they win inside it too: an empty
 * tmpfs over each hidden directory (with its exceptions bound back read-only) and `/dev/null` over each hidden
 * file. Only paths that exist can be masked, and bwrap cannot name dotenv files in advance, so
 * `dotenvOutsideWorkspace` is not applied here beyond the listed paths.
 */
function bwrapReadDenyArgs(policy: SandboxPolicy): string[] {
  const deny = canonicalReadDeny(policy)
  if (deny === undefined) return []
  const args: string[] = []
  for (const path of deny.paths) {
    const info = statSync(path, { throwIfNoEntry: false })
    if (info === undefined) continue
    if (info.isDirectory()) {
      args.push('--tmpfs', path)
      for (const allowed of deny.except) {
        if (statSync(allowed, { throwIfNoEntry: false }) !== undefined && allowed !== path && isUnder(allowed, path)) args.push('--ro-bind', allowed, allowed)
      }
    } else {
      args.push('--ro-bind', '/dev/null', path)
    }
  }
  return args
}

/**
 * Whether a policy asks the backend to limit network access.
 * @param policy - the policy for one execution.
 * @returns true for `off` and `allowlist`.
 */
export function limitsNetwork(policy: SandboxPolicy): boolean {
  return policy.network !== undefined && policy.network.mode !== 'on'
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  // No connections to other hosts; the loopback interface stays open, which is how `allowlist` reaches its
  // proxy and how tests reach a local server. Unix-domain sockets (name resolution among them) are untouched.
  if (limitsNetwork(policy)) {
    forms.push('(deny network-outbound (remote ip "*:*"))', '(allow network-outbound (remote ip "localhost:*"))')
  }
  forms.push(...seatbeltReadDenyForms(policy))
  return ['-p', forms.join(' ')]
}

/**
 * SBPL for the policy's read-deny. Seatbelt applies the last matching rule, so the order is the meaning:
 * dotenv files are denied everywhere and then allowed again inside the workspace; the listed paths are denied
 * after that, inside the workspace too; their exceptions are allowed last. Only reading contents is denied
 * (`file-read-data`), so names and sizes stay visible and a listing of the home directory still works.
 */
function seatbeltReadDenyForms(policy: SandboxPolicy): string[] {
  const deny = canonicalReadDeny(policy)
  if (deny === undefined) return []
  const subpaths = (paths: readonly string[]) => paths.map(path => `(subpath ${sbplString(path)})`).join(' ')
  const forms: string[] = []
  if (deny.dotenvOutsideWorkspace) {
    forms.push(String.raw`(deny file-read-data (regex #"/\.env(\.[^/]+)?$"))`, `(allow file-read-data ${subpaths([canonicalPath(policy.workspaceRoot)])})`)
  }
  if (deny.paths.length > 0) forms.push(`(deny file-read-data ${subpaths(deny.paths)})`)
  if (deny.except.length > 0) forms.push(`(allow file-read-data ${subpaths(deny.except)})`)
  return forms
}
