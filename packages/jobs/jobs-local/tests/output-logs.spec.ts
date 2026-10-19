/** A discarded job's output logs are removed with it, and only the subprocess provider's own spill files. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeOutputLogs } from '../src/index.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('removeOutputLogs', () => {
  it('removes spill files and leaves any other path alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-job-logs-'))
    dirs.push(dir)
    const spill = join(dir, 'dsh-subprocess-1-2-abcdef-stdout.log')
    const other = join(dir, 'notes.txt')
    writeFileSync(spill, 'x'.repeat(1024))
    writeFileSync(other, 'keep')
    removeOutputLogs([spill, undefined, other, spill, join(dir, 'dsh-subprocess-missing.log')])
    expect(existsSync(spill)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })
})
