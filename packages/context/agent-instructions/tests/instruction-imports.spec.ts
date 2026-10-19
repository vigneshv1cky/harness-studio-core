import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadBaselineInstructions, withSavedLimit } from '@deepseek-ai/dsh-agent-instructions'
import { MAX_IMPORT_READS, readDenyFilter } from '../src/files.ts'

describe('@path imports in instruction files', () => {
  let base: string
  let project: string
  let home: string
  let outside: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-instruction-imports-'))
    project = join(base, 'project')
    home = join(base, 'home')
    outside = join(base, 'outside')
    await mkdir(join(project, '.git'), { recursive: true })
    await mkdir(join(project, 'docs'), { recursive: true })
    await mkdir(home, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.md'), 'OUTSIDE-SECRET\n')
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  async function load(maxBytes = 131072, options: { cwd?: string; maxSourceBytes?: number } = {}): Promise<string> {
    const rendered = await loadBaselineInstructions({ cwd: project, dshHome: home, agentsHome: join(base, 'agents'), maxBytes, ...options })
    return rendered?.text ?? ''
  }

  it('expands a project file import relative to the importing file', async () => {
    await writeFile(join(project, 'AGENTS.md'), 'Root rule.\n@docs/style.md\n')
    await writeFile(join(project, 'docs', 'style.md'), 'Use tabs.\n@./nested.md\n')
    await writeFile(join(project, 'docs', 'nested.md'), 'Nested rule.\n')
    const text = await load()
    expect(text).toContain('Root rule.\n@docs/style.md\n\nImported from docs/style.md:\n\nUse tabs.')
    expect(text).toContain('Imported from docs/nested.md:\n\nNested rule.')
  })

  it('keeps project imports inside the project root, including through symlinks', async () => {
    await symlink(join(outside, 'secret.md'), join(project, 'docs', 'link.md'))
    await writeFile(join(project, 'AGENTS.md'), `@../outside/secret.md\n@${join(outside, 'secret.md')}\n@docs/link.md\n`)
    const text = await load()
    expect(text).not.toContain('OUTSIDE-SECRET')
    expect(text).toContain('@../outside/secret.md')
  })

  it('lets the user-global file import any readable file', async () => {
    await writeFile(join(home, 'AGENTS.md'), `Personal rules:\n@${join(outside, 'secret.md')}\n`)
    const text = await load()
    expect(text).toContain('OUTSIDE-SECRET')
  })

  it('does not read the shared agents root, so nothing it imports loads either', async () => {
    await mkdir(join(base, 'agents'), { recursive: true })
    await writeFile(join(base, 'agents', 'AGENTS.md'), `SHARED RULES\n@${join(outside, 'secret.md')}\n`)
    const text = await load()
    expect(text).not.toContain('SHARED RULES')
    expect(text).not.toContain('OUTSIDE-SECRET')
  })

  it('gives a project file project rules even when its displayed path looks user-global', async () => {
    // Folders named `~/.agents`, `~/.dsh` or `$DSH_AGENTS_HOME` inside the repository display like the global roots.
    for (const folder of [join('~', '.agents'), join('~', '.dsh'), '$DSH_AGENTS_HOME', '$DSH_HOME']) {
      const dir = join(project, folder)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'AGENTS.md'), `Folder rules.\n@${join(outside, 'secret.md')}\n@~/../../${join(outside, 'secret.md')}\n`)
      const text = await load(131072, { cwd: dir })
      expect(text).toContain('Folder rules.')
      expect(text).not.toContain('OUTSIDE-SECRET')
    }
  })

  it('reads each imported file once per expansion, however often it is named, and caps reads per load', async () => {
    // Six files each naming the next 51 times would otherwise read the last one 51^5 times.
    for (let level = 0; level < 6; level += 1) {
      await writeFile(join(project, 'docs', `f${level}.md`), `F${level}\n${`@f${level + 1}.md\n`.repeat(51)}`)
    }
    await writeFile(join(project, 'docs', 'f6.md'), 'F6\n')
    await writeFile(join(project, 'AGENTS.md'), '@docs/f0.md\n'.repeat(51))
    const started = Date.now()
    const text = await load()
    expect(Date.now() - started).toBeLessThan(5000)
    for (let level = 0; level <= 4; level += 1) expect(text.match(new RegExp(`Imported from docs/f${level}\\.md`, 'g'))).toHaveLength(1)

    const many = Array.from({ length: 250 }, (_, index) => `@docs/m${index}.md`)
    await Promise.all(many.map((_, index) => writeFile(join(project, 'docs', `m${index}.md`), `M${index}\n`)))
    await writeFile(join(project, 'AGENTS.md'), `${many.join('\n')}\n`)
    const capped = await load()
    const imported = capped.match(/Imported from docs\/m\d+\.md/g) ?? []
    expect(imported.length).toBe(MAX_IMPORT_READS)
    expect(capped).toContain('@docs/m249.md')
  })

  it('stops reading imports once the file and its imports reach the source cap', async () => {
    await writeFile(join(project, 'docs', 'a.md'), `${'a'.repeat(600)}\n`)
    await writeFile(join(project, 'docs', 'b.md'), `${'b'.repeat(600)}\n`)
    await writeFile(join(project, 'AGENTS.md'), '@docs/a.md\n@docs/b.md\n')
    const text = await load(131072, { maxSourceBytes: 1000 })
    expect(text).toContain('a'.repeat(600))
    expect(text).not.toContain('b'.repeat(600))
    expect(text).toContain('@docs/b.md')
  })

  it('never imports the secret files the sandbox policy hides, even from the user-global file', async () => {
    await mkdir(join(outside, '.ssh'), { recursive: true })
    await writeFile(join(outside, '.ssh', 'id_ed25519'), 'PRIVATE-KEY\n')
    await writeFile(join(outside, '.ssh', 'config'), 'SSH-CONFIG\n')
    await writeFile(join(outside, '.env'), 'DOTENV-SECRET\n')
    await writeFile(join(home, 'AGENTS.md'), [`@${join(outside, '.ssh', 'id_ed25519')}`, `@${join(outside, '.ssh', 'config')}`, `@${join(outside, '.env')}`, `@${join(outside, 'secret.md')}`, ''].join('\n'))
    const hiddenImport = readDenyFilter({ paths: [join(outside, '.ssh')], except: [join(outside, '.ssh', 'config')], dotenvOutsideWorkspace: true }, project)
    const rendered = await loadBaselineInstructions({ cwd: project, dshHome: home, agentsHome: join(base, 'agents'), maxBytes: 131072, ...hiddenImport === undefined ? {} : { hiddenImport } })
    expect(rendered?.text).not.toContain('PRIVATE-KEY')
    expect(rendered?.text).not.toContain('DOTENV-SECRET')
    expect(rendered?.text).toContain('SSH-CONFIG')
    expect(rendered?.text).toContain('OUTSIDE-SECRET')
    expect(readDenyFilter(undefined, project)).toBeUndefined()
    const filter = readDenyFilter({ paths: [], except: [], dotenvOutsideWorkspace: true }, project)
    expect(filter?.(join(project, '.env'))).toBe(false)
    expect(filter?.(join(outside, '.env.local'))).toBe(true)
  })

  it('ignores references in code, e-mail addresses and missing files', async () => {
    await writeFile(join(project, 'docs', 'style.md'), 'STYLE\n')
    await writeFile(join(project, 'AGENTS.md'), [
      '```',
      '@docs/style.md',
      '```',
      'Inline `@docs/style.md` stays code.',
      'Mail me at someone@docs/style.md or a@b.md.',
      '@docs/missing.md',
      '',
    ].join('\n'))
    const text = await load()
    expect(text).not.toContain('STYLE')
    expect(text).toContain('@docs/missing.md')
  })

  it('stops at import cycles and the depth limit', async () => {
    await writeFile(join(project, 'AGENTS.md'), '@docs/a.md\n')
    await writeFile(join(project, 'docs', 'a.md'), 'A\n@b.md\n')
    await writeFile(join(project, 'docs', 'b.md'), 'B\n@a.md\n')
    const cycle = await load()
    expect(cycle.match(/Imported from docs\/a\.md/g)).toHaveLength(1)
    expect(cycle.match(/Imported from docs\/b\.md/g)).toHaveLength(1)

    for (let level = 1; level <= 7; level += 1) {
      await writeFile(join(project, 'docs', `d${level}.md`), `D${level}\n@d${level + 1}.md\n`)
    }
    await writeFile(join(project, 'AGENTS.md'), '@docs/d1.md\n')
    const deep = await load()
    expect(deep).toContain('D5')
    expect(deep).not.toContain('D6')
  })

  it('reports a cut in the budget marker once imports exceed the limit', async () => {
    await writeFile(join(project, 'AGENTS.md'), '@docs/big.md\n')
    await writeFile(join(project, 'docs', 'big.md'), 'x'.repeat(4000))
    const text = await load(2048)
    expect(text).toMatch(/Workspace instruction budget 2048 bytes: truncated AGENTS\.md from \d+ to \d+ bytes/)
  })

  it('loads AGENTS.md and AGENTS.local.md, never CLAUDE.md or CLAUDE.local.md', async () => {
    await writeFile(join(project, 'AGENTS.md'), 'AGENTS RULES\n')
    await writeFile(join(project, 'AGENTS.local.md'), 'LOCAL RULES\n')
    await writeFile(join(project, 'CLAUDE.md'), 'CLAUDE RULES\n')
    await writeFile(join(project, 'CLAUDE.local.md'), 'CLAUDE LOCAL RULES\n')
    const both = await load()
    expect(both).toContain('AGENTS RULES')
    expect(both.indexOf('AGENTS RULES')).toBeLessThan(both.indexOf('LOCAL RULES'))
    expect(both).not.toContain('CLAUDE RULES')
    expect(both).not.toContain('CLAUDE LOCAL RULES')
  })

  it('loads nothing from a folder that has only CLAUDE.md', async () => {
    await writeFile(join(project, 'CLAUDE.md'), 'CLAUDE RULES\n')
    await writeFile(join(project, 'CLAUDE.local.md'), 'CLAUDE LOCAL RULES\n')
    expect(await load()).toBe('')
  })

  it('expands an explicit @CLAUDE.md import from AGENTS.md', async () => {
    await writeFile(join(project, 'AGENTS.md'), 'AGENTS RULES\n@CLAUDE.md\n')
    await writeFile(join(project, 'CLAUDE.md'), 'CLAUDE RULES\n')
    const text = await load()
    expect(text).toContain('AGENTS RULES\n@CLAUDE.md\n\nImported from CLAUDE.md:\n\nCLAUDE RULES')
    expect(text.match(/CLAUDE RULES/g)).toHaveLength(1)
  })

  it('does not repeat AGENTS.md when a folder\'s AGENTS.md only includes it', async () => {
    await writeFile(join(project, 'AGENTS.md'), 'SHARED RULES\n')
    await mkdir(join(project, 'web'), { recursive: true })
    await writeFile(join(project, 'web', 'AGENTS.md'), '@../AGENTS.md\nWeb rules.\n')
    const rendered = await loadBaselineInstructions({ cwd: join(project, 'web'), dshHome: home, agentsHome: join(base, 'agents'), maxBytes: 131072 })
    expect(rendered?.text.match(/SHARED RULES/g)).toHaveLength(1)
    expect(rendered?.text).toContain('Web rules.')
  })

  it('uses the limit saved on the Instructions page, with 0 meaning no limit', async () => {
    const configured = { dshHome: home, agentsHome: join(base, 'agents'), projectRootMarkers: ['.git'], instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md'], localInstructionFileCandidates: ['AGENTS.local.md', 'CLAUDE.local.md'], maxBytes: 131072, maxSourceBytes: 1048576 }
    expect(withSavedLimit(configured).maxBytes).toBe(131072)
    await mkdir(join(home, 'harness-studio'), { recursive: true })
    await writeFile(join(home, 'harness-studio', 'instructions.json'), JSON.stringify({ maxBytes: 262144 }))
    expect(withSavedLimit(configured).maxBytes).toBe(262144)
    await writeFile(join(home, 'harness-studio', 'instructions.json'), JSON.stringify({ maxBytes: 0 }))
    expect(withSavedLimit(configured).maxBytes).toBe(Number.MAX_SAFE_INTEGER)
    await writeFile(join(home, 'harness-studio', 'instructions.json'), 'not json')
    expect(withSavedLimit(configured).maxBytes).toBe(131072)
  })
})
