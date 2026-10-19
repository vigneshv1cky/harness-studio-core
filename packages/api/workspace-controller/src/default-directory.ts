/** Resolve the Host account's Documents directory for first-use Workspace creation. */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { DEFAULT_WORKSPACE_DIRECTORY } from './default-workspace.ts'

/** Platform observations replaceable in directory-resolution tests. */
interface DocumentsDirectoryInternals {
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly run?: NativeCommandRunner
  readonly isDirectory?: (path: string) => Promise<boolean>
}

/** Harness Studio: the Documents folder that holds the first-use Workspace. */
const WORKSPACE_PARENT = 'Harness Studio'
/** The folder DeepSeek Harness and earlier Harness Studio builds used; an existing first-use Workspace there is kept. */
const LEGACY_WORKSPACE_PARENT = 'deepseek-harness'

/**
 * Report whether a directory exists, treating a missing path as absent.
 * @param path - absolute path.
 * @returns whether the path is an existing directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false
    throw error
  }
}

/**
 * Validate a configured or OS-returned Documents path without resolving it against cwd.
 * @param directory - fully qualified directory spelling.
 * @param platform - Host platform.
 * @returns the normalized directory.
 */
export function validateDocumentsDirectory(directory: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? win32 : posix
  const root = paths.parse(directory).root
  if (!paths.isAbsolute(directory) || (platform === 'win32' && (root === '\\' || root === '/'))) {
    throw new Error(`Documents directory must be fully qualified: '${directory}'`)
  }
  return paths.normalize(directory)
}

/**
 * Resolve the first-use directory on the Host without creating files: `<Documents>/Harness Studio/default-workspace`,
 * or `<Documents>/deepseek-harness/default-workspace` when that directory already exists.
 * @param documentsDirectory - explicit deployment override for the system Documents directory.
 * @param signal - caller lifetime and lookup deadline.
 * @param internals - platform facts, native command runner and directory probe.
 * @returns the absolute candidate path.
 */
export async function defaultWorkspaceDirectory(
  documentsDirectory: string | undefined,
  signal: AbortSignal,
  internals: DocumentsDirectoryInternals = {},
): Promise<string> {
  const platform = internals.platform ?? process.platform
  const paths = platform === 'win32' ? win32 : posix
  signal.throwIfAborted()
  let directory = documentsDirectory
  if (directory === undefined) {
    const run = internals.run ?? runNativeCommand
    let stdout: string
    switch (platform) {
      case 'darwin':
        ({ stdout } = await run('osascript', [
          '-e', 'POSIX path of (path to documents folder from user domain without folder creation)',
        ], signal, 'hidden'))
        break
      case 'win32':
        ({ stdout } = await run('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
          + '[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, '
          + '[Environment+SpecialFolderOption]::DoNotVerify)',
        ], signal, 'hidden'))
        break
      case 'linux':
        // Harness Studio: minimal systems have no xdg-user-dir; fall back to ~/Documents, the XDG default.
        try {
          ({ stdout } = await run('xdg-user-dir', ['DOCUMENTS'], signal, 'hidden'))
        } catch (_missing) {
          signal.throwIfAborted()
          stdout = paths.join(internals.home ?? homedir(), 'Documents')
        }
        break
      default:
        throw new Error(`system Documents directory is unavailable on ${platform}`)
    }
    directory = stdout.replace(/[\r\n]+$/, '')
    // XDG reports the home directory when this user directory is disabled; Harness Studio then uses ~/Documents.
    if (platform === 'linux' && (directory === '' || paths.resolve(directory) === paths.resolve(internals.home ?? homedir()))) {
      directory = paths.join(internals.home ?? homedir(), 'Documents')
    }
    if (directory === '') throw new Error('system Documents directory is unavailable')
  }
  directory = validateDocumentsDirectory(directory, platform)
  signal.throwIfAborted()
  // Keep a first-use Workspace that already holds the user's files rather than starting a second, empty one.
  const legacy = paths.join(directory, LEGACY_WORKSPACE_PARENT, DEFAULT_WORKSPACE_DIRECTORY)
  if (await (internals.isDirectory ?? isDirectory)(legacy)) return legacy
  signal.throwIfAborted()
  return paths.join(directory, WORKSPACE_PARENT, DEFAULT_WORKSPACE_DIRECTORY)
}
