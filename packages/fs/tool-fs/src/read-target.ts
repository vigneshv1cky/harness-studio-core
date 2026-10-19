/**
 * Shared path resolution and regular-file validation for model-facing read tools.
 * @module @deepseek-ai/dsh-tool-fs/src/read-target
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { readDenied } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { sessionResolveOptions } from './session-cwd.ts'

/**
 * Refuse a target the sandbox policy hides (secret files such as SSH keys, and dotenv files outside the
 * workspace), so the file tools cannot see what a confined command cannot. Edits and writes check it too,
 * since their results show the file's old content.
 * @param target - the resolved target; its key is the canonical local path.
 * @param policy - the per-call policy; undefined hides nothing.
 */
export function refuseSecret(target: FsTarget, policy: SandboxExecutionPolicy | undefined): void {
  if (policy !== undefined && readDenied(target.targetKey, policy)) {
    throw new FsError(`cannot read "${target.displayPath}": it is a secret file that Harness Studio hides from the agent. Do not look for a copy; ask the user if the task needs it.`, 'FS_SANDBOX_DENIED')
  }
}

/**
 * Resolve a model-supplied path, observe absence, and require a regular file.
 * @param ctx - the plugin context providing filesystem resolution and observation events.
 * @param exec - the current tool execution, including the owning Agent and cancellation.
 * @param requestedPath - the raw path supplied to the tool.
 * @returns the resolved target and its single stat result.
 */
export async function resolveRegularReadTarget(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
): Promise<{ target: FsTarget; info: FsInfo }> {
  const target = await ctx.fs.resolve(requestedPath, await sessionResolveOptions(ctx, exec))
  refuseSecret(target, ctx.get('sandboxPolicy')?.resolve(exec.agent ? { session: exec.agent.session } : {}))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') {
    throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  return { target, info }
}
