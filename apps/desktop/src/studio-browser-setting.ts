/**
 * Harness Studio's opt-in Browser pane sign-in compatibility setting, stored in
 * `<userData>/desktop/browser-pane.json` as `{ "signInCompatibility": boolean }`.
 * Off when the file is missing or unreadable; a change takes effect after a restart.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function settingPath(userData: string): string {
  return join(userData, 'desktop', 'browser-pane.json')
}

/**
 * Read whether the Browser pane uses the sign-in compatible identity and shared storage.
 * @param userData - Electron's userData directory.
 * @returns true only when the stored document says so.
 */
export function readBrowserSignInCompatibility(userData: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(settingPath(userData), 'utf8'))
    return typeof value === 'object' && value !== null && (value as { signInCompatibility?: unknown }).signInCompatibility === true
  } catch (_error) {
    // A missing or malformed document leaves the setting off, the upstream behaviour.
    return false
  }
}

/**
 * Store the setting for the next start.
 * @param userData - Electron's userData directory.
 * @param enabled - whether the next start uses sign-in compatibility.
 */
export function writeBrowserSignInCompatibility(userData: string, enabled: boolean): void {
  const path = settingPath(userData)
  mkdirSync(join(userData, 'desktop'), { recursive: true, mode: 0o700 })
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ signInCompatibility: enabled }, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}
