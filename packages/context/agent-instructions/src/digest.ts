/**
 * Content identity for workspace instruction duplicate suppression.
 *
 * @module @deepseek-ai/dsh-agent-instructions/digest
 */

import { createHash } from 'node:crypto'

/**
 * Compute the content identity used across instruction loading and session state.
 * @param content - exact UTF-8 instruction text.
 * @returns lowercase SHA-1 digest in hexadecimal form.
 */
export function instructionContentSha1(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

/**
 * Compute the whitespace-insensitive identity used for per-directory duplicate
 * suppression. Leading and trailing whitespace is trimmed before hashing so a
 * symlinked or byte-copied sibling that differs only by surrounding whitespace
 * still collapses to a single rendered file.
 * @param content - exact UTF-8 instruction text.
 * @returns SHA-1 digest of the trimmed content.
 */
export function trimmedInstructionDigest(content: string): string {
  return instructionContentSha1(content.trim())
}

/**
 * Identity used to keep one instruction file per candidate kind in a project directory.
 * Harness Studio loads one base file (`AGENTS.md`) and one local overlay (`AGENTS.local.md`) per
 * project directory; should a configuration list more candidates of a kind, the later one is
 * dropped whatever its content, so a directory never pays for its instructions twice. The
 * user-global file collapses only on matching content.
 * @param displayPath - model-facing path of the loaded file.
 * @param content - exact UTF-8 instruction text.
 * @returns a per-kind key for project files, or the trimmed-content digest for user-global files.
 */
export function instructionDuplicateKey(displayPath: string, content: string): string {
  const name = displayPath.slice(Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\')) + 1)
  const userGlobal = displayPath.startsWith('~/') || displayPath.startsWith('$')
  if (userGlobal) return trimmedInstructionDigest(content)
  return /\.local\.md$/i.test(name) ? 'candidate:local' : 'candidate:base'
}
