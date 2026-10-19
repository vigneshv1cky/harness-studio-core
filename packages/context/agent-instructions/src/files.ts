/**
 * Instruction-file discovery and bounded, abort-aware provider reads.
 *
 * @module @deepseek-ai/dsh-agent-instructions/files
 */

import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileSystem, FsInfo, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { dshHomeDisplay } from '@deepseek-ai/dsh-home-paths'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { resolveConfig, resolveDiscoveryConfig, type ResolvedConfig, type ResolvedDiscoveryConfig } from './config.ts'
import { instructionDuplicateKey } from './digest.ts'
import {
  decodeScopeKey,
  escapeProjectDisplayPath,
  instructionCandidateGroup,
  renderAgentInstructionSet,
  scopeForDisplayPath,
  type RenderedAgentInstructions,
  USER_GLOBAL_DIRECTORY,
  USER_GLOBAL_DIRECTORIES,
  USER_GLOBAL_FILE,
} from './render.ts'

/** An instruction candidate identified by absolute and model-facing paths. */
export interface InstructionFile {
  absolutePath: string
  displayPath: string
}

/** An instruction file whose UTF-8 content was read successfully. */
export interface LoadedInstructionFile extends InstructionFile {
  content: string
  /** Provider freshness token when the file was loaded through `ctx.fs`. */
  version?: FsVersion
}

interface DiscoveredInstructionFile extends InstructionFile {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

/** Provider metadata for a probed scope candidate before its content is read. */
export interface ProbedInstructionFile extends InstructionFile {
  target: FsTarget
  version: FsVersion
  size?: number
}

interface DiscoverOptions {
  cwd: string
  /**
   * Already-resolved harness home. The plugin resolves it once at mount and
   * passes it down so reconciliation and baseline loading cannot disagree.
   */
  dshHome?: string
  /**
   * Already-resolved shared agents root. The plugin resolves it once at mount
   * and passes it down so reconciliation and baseline loading cannot disagree.
   */
  agentsHome?: string
  projectRootMarkers?: string[]
  instructionFileCandidates?: string[]
  localInstructionFileCandidates?: string[]
  projectRoot?: string
  signal?: AbortSignal
}

interface UserGlobalRoot {
  /** Logical scope directory used in reconciliation keys. */
  directory: string
  /** Absolute directory holding the candidate file. */
  home: string
  /** Model-facing directory label. */
  display: string
}

/**
 * Ordered user-global instruction roots: the harness home, then the shared
 * agents root. Both contribute the fixed {@link USER_GLOBAL_FILE} candidate and
 * form one candidate group, so a file that matches the harness-home content
 * renders once.
 * @param config - normalized discovery configuration.
 * @returns the roots in model precedence order.
 */
function userGlobalRoots(config: ResolvedDiscoveryConfig): UserGlobalRoot[] {
  return USER_GLOBAL_DIRECTORIES.map((directory) => {
    switch (directory) {
      case USER_GLOBAL_DIRECTORY:
        return { directory, home: config.dshHome, display: dshHomeDisplay(config.dshHome) }
      /* v8 ignore next -- USER_GLOBAL_DIRECTORIES is closed; this arm only makes adding a label a compile error. */
      default:
        return assertNever(directory, 'user-global directory')
    }
  })
}

interface LoadOptions extends DiscoverOptions {
  maxBytes: number
  maxSourceBytes?: number
  replacePreviousBaseline?: boolean
}

/** Rendered baseline plus the successfully read and byte-budget-retained files. */
export interface RenderedInstructionSet {
  rendered: RenderedAgentInstructions
  /** Successfully read candidates before content deduplication and byte budgeting. */
  observed: LoadedInstructionFile[]
  /**
   * Candidates dropped as content duplicates of an earlier candidate in their
   * group. Duplicates of budget-retained content remain eligible for probing,
   * because deleting or changing the retained candidate can make them visible.
   */
  deduped: LoadedInstructionFile[]
  /** Candidates retained by content deduplication and byte budgeting. */
  included: LoadedInstructionFile[]
}
/** Tri-state scope probe that distinguishes confirmed absence from provider failure. */
export type ScopeInstructionProbe =
  | { kind: 'present'; file: ProbedInstructionFile }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

interface StatFileInfo {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

type StatFileProbe =
  | { kind: 'present'; info: StatFileInfo }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

function signalOptions(signal?: AbortSignal): { signal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function isMissingProviderPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'FS_NOT_FOUND'
}

async function nodeStatFile(path: string, signal?: AbortSignal): Promise<StatFileProbe> {
  try {
    signal?.throwIfAborted()
    // stat (not lstat) follows a final-component symlink so a link to a regular
    // file loads; a broken link surfaces as ENOENT and is treated as absent below.
    const info = await stat(path)
    signal?.throwIfAborted()
    if (!info.isFile()) return { kind: 'absent' }
    return { kind: 'present', info: { size: info.size } }
  } catch (error: unknown) {
    signal?.throwIfAborted()
    return isMissingPathError(error) ? { kind: 'absent' } : { kind: 'unavailable' }
  }
}

async function fsStatFile(
  path: string,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  // resolve() follows a final-component symlink to its target's stable identity;
  // stat then classifies that target. A link to a regular file loads, while a
  // missing path or non-file target (including a link to a directory) is absent.
  try {
    const target = await fileSystem.resolve(path, signalOptions(signal))
    signal?.throwIfAborted()
    const info = await fileSystem.stat(target, signal)
    signal?.throwIfAborted()
    if (info?.type !== 'file') return { kind: 'absent' }
    return {
      kind: 'present',
      info: { target, version: info.version, ...info.size === undefined ? {} : { size: info.size } },
    }
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
}

async function statFile(
  path: string,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  return fileSystem === undefined ? nodeStatFile(path, signal) : fsStatFile(path, fileSystem, signal)
}

async function existsAsMarker(path: string, fileSystem?: FileSystem, signal?: AbortSignal): Promise<boolean> {
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(path, signalOptions(signal))
      return await fileSystem.stat(target, signal) !== undefined
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (isMissingProviderPathError(error)) return false
      throw error
    }
  }
  try {
    signal?.throwIfAborted()
    await stat(path)
    signal?.throwIfAborted()
    return true
  } catch (error: unknown) {
    signal?.throwIfAborted()
    if (isMissingPathError(error)) return false
    throw error
  }
}

/**
 * Walk upward to the first directory containing a configured root marker.
 * @param cwd - absolute session working directory where the walk begins.
 * @param markers - child names that identify a project root.
 * @param fileSystem - optional provider used instead of host filesystem probes.
 * @param signal - cancellation for provider and host probes.
 * @returns the discovered project root, or `cwd` when no marker exists.
 * @throws the original marker metadata error or cancellation reason when a probe is unavailable.
 */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await existsAsMarker(join(current, marker), fileSystem, signal)) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Build the inclusive root-to-cwd directory chain.
 * @param root - root directory expected to contain or equal `cwd`.
 * @param cwd - most-specific directory in the chain.
 * @returns directories ordered from broadest to most specific.
 */
export function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    /* v8 ignore next -- discovery always supplies cwd or an ancestor root. */
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/**
 * Find descendant directories crossed between a cwd and a touched file.
 * @param root - current working directory that bounds nested discovery.
 * @param touchedPath - absolute path or path relative to `root`.
 * @returns descendant directories from shallowest through the touched file's parent.
 */
export function descendantDirsBetween(root: string, touchedPath: string): string[] {
  const resolvedRoot = resolve(root)
  const targetPath = isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(resolvedRoot, touchedPath)
  const targetDir = dirname(targetPath)
  const rel = relative(resolvedRoot, targetDir)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return []
  return ancestorChain(resolvedRoot, targetDir).slice(1)
}

/**
 * Convert an absolute instruction path to its project display path.
 * @param root - project root used as the display base.
 * @param path - absolute path to display.
 * @returns the collision-free root-relative path.
 */
export function relativeDisplay(root: string, path: string): string {
  return escapeProjectDisplayPath(relative(root, path))
}

async function allExistingInstructionFiles(
  dir: string,
  root: string,
  instructionFileCandidates: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<DiscoveredInstructionFile[]> {
  const found: DiscoveredInstructionFile[] = []
  for (const candidate of instructionFileCandidates) {
    const path = join(dir, candidate)
    const probe = await statFile(path, fileSystem, signal)
    switch (probe.kind) {
      case 'present':
        found.push({ absolutePath: path, displayPath: relativeDisplay(root, path), ...probe.info })
        continue
      // A missing candidate is skipped; a transient provider failure skips only
      // that candidate so the remaining independent candidates still load.
      case 'absent':
      case 'unavailable':
        continue
      /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
      default:
        assertNever(probe, 'StatFileProbe')
    }
  }
  return found
}

async function discoverInstructionFiles(
  options: DiscoverOptions,
  fileSystem?: FileSystem,
): Promise<DiscoveredInstructionFile[]> {
  const config = resolveDiscoveryConfig(options)
  const files: DiscoveredInstructionFile[] = []
  const seen = new Set<string>()
  const addFile = (file: DiscoveredInstructionFile): void => {
    if (seen.has(file.absolutePath)) return
    seen.add(file.absolutePath)
    files.push(file)
  }

  for (const root of userGlobalRoots(config)) {
    const absolutePath = join(root.home, USER_GLOBAL_FILE)
    const probe = await statFile(absolutePath, fileSystem, options.signal)
    switch (probe.kind) {
      case 'present':
        addFile({
          absolutePath,
          displayPath: `${root.display}/${USER_GLOBAL_FILE}`,
          ...probe.info,
        })
        continue
      case 'absent':
      case 'unavailable':
        continue
      /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
      default:
        assertNever(probe, 'StatFileProbe')
    }
  }

  const cwd = resolve(options.cwd)
  const projectRoot = options.projectRoot
    ?? await findProjectRoot(cwd, config.projectRootMarkers, fileSystem, options.signal)
  for (const dir of ancestorChain(projectRoot, cwd)) {
    for (const candidates of [config.instructionFileCandidates, config.localInstructionFileCandidates]) {
      for (const file of await allExistingInstructionFiles(dir, projectRoot, candidates, fileSystem, options.signal)) {
        addFile(file)
      }
    }
  }
  return files
}

/**
 * Discover host-visible user-global and root-to-cwd instruction candidates.
 * All present candidates in each directory are returned; trimmed-content
 * duplicates are collapsed later, once content is read.
 * @param options - cwd, resolved harness home, root marker, and candidate configuration.
 * @returns path-deduplicated instruction candidates in model precedence order.
 * @throws the original root-marker metadata error or cancellation reason when
 * discovery cannot identify the project root.
 */
export async function discoverBaselineInstructionFiles(options: DiscoverOptions): Promise<InstructionFile[]> {
  return (await discoverInstructionFiles(options)).map(({ absolutePath, displayPath }) => ({ absolutePath, displayPath }))
}

async function* nodeTextChunks(path: string, signal?: AbortSignal): AsyncIterable<string> {
  const stream = createReadStream(path, { encoding: 'utf8', signal })
  for await (const chunk of stream) yield String(chunk)
}

async function readBounded(
  file: { absolutePath: string; target?: FsTarget; size?: number },
  maxSourceBytes: number,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // TODO(total-instruction-read-bound): enforce an aggregate source budget
  // across a complete baseline or reconciliation batch; the render budget is
  // applied only after every accepted file has been read under this per-file cap.
  signal?.throwIfAborted()
  if (file.size !== undefined && file.size > maxSourceBytes) return undefined
  try {
    const chunks = fileSystem === undefined || file.target === undefined
      ? nodeTextChunks(file.absolutePath, signal)
      : await fileSystem.streamText(file.target, signal)
    const parts: string[] = []
    let bytes = 0
    for await (const chunk of chunks) {
      signal?.throwIfAborted()
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > maxSourceBytes) return undefined
      parts.push(chunk)
    }
    signal?.throwIfAborted()
    return parts.join('')
  } catch {
    signal?.throwIfAborted()
    // A file may disappear or become unreadable after its metadata probe.
    return undefined
  }
}

/**
 * Import depth limit for `@path` references, matching Claude Code's CLAUDE.md
 * import rule so files written for it expand the same way here.
 */
const MAX_IMPORT_DEPTH = 5

/**
 * An `@path` import token: at line start or after whitespace or `(`, naming a
 * home-relative (`~/`), absolute, `./` or `../` path, or a relative path whose
 * last segment has an extension. The leading-character rule keeps e-mail
 * addresses and `name@version` specifiers out.
 */
const IMPORT_TOKEN = /(^|[\s(])@((?:~\/|\.{1,2}\/|\/)[^\s)`'"<>]+|[\w.-]+(?:\/[^\s)`'"<>]+)*\.[A-Za-z0-9]+)/g

const FENCE = /^\s{0,3}(```|~~~)/

/**
 * Instruction file names discovery loads on its own, so an import of one would load it twice. CLAUDE.md is
 * not discovered, so an explicit `@CLAUDE.md` import expands like any other file.
 */
const INSTRUCTION_FILE_NAME = /^AGENTS(?:\.local)?\.md$/i

/** Most files one load may read for `@path` imports, across every instruction file it expands. */
export const MAX_IMPORT_READS = 200

/**
 * Shared count of import reads for one load. Pass the same object to every
 * {@link expandInstructionImports} call of a load so the cap covers the whole load.
 */
export interface ImportReadCounter {
  reads: number
}

interface ImportScope {
  /** Project root that imported files must stay inside; undefined allows any readable file. */
  root: string | undefined
  /** The project root with symlinks resolved, checked against each import's real path. */
  realRoot: string | undefined
  /** Directory used to display imported paths relative to, when inside it. */
  displayRoot: string | undefined
  maxSourceBytes: number
  fileSystem: FileSystem | undefined
  signal: AbortSignal | undefined
  /** Reads so far in this load, capped at {@link MAX_IMPORT_READS}. */
  counter: ImportReadCounter
  /** Real paths already imported while expanding this file: each is read and shown once. */
  seen: Set<string>
  /** UTF-8 bytes of the expansion so far: the file plus every import and label added. */
  bytes: number
  /** Set once the byte budget or read cap is reached; nothing more is read. */
  stopped: boolean
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    // The path is not on this host (a remote provider) or is missing; the
    // provider read below decides whether it exists.
    return path
  }
}

function importDisplay(path: string, scope: ImportScope): string {
  if (scope.displayRoot !== undefined && isInside(scope.displayRoot, path)) return relative(scope.displayRoot, path) || '.'
  const home = homedir()
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

/**
 * Whether discovery loads `target` anyway: an instruction file in the importing file's own folder or
 * a folder above it (within the project root for project files). Importing it would repeat its text,
 * as in an `AGENTS.local.md` that only says `@AGENTS.md`.
 */
function loadedByDiscovery(target: string, importer: string, scope: ImportScope): boolean {
  if (!INSTRUCTION_FILE_NAME.test(basename(target))) return false
  const folder = dirname(target)
  const from = dirname(importer)
  if (!isInside(folder, from)) return false
  return scope.root === undefined ? folder === from : isInside(scope.root, folder)
}

function maskInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, match => ' '.repeat(match.length))
}

/**
 * Read one import within what is left of the byte budget, counting the read. A file larger than the budget
 * left, or a read past the cap, stops the whole expansion: nothing after it is read.
 */
async function readImport(path: string, scope: ImportScope): Promise<string | undefined> {
  if (scope.counter.reads >= MAX_IMPORT_READS) {
    scope.stopped = true
    return undefined
  }
  // Probes count too, so references to missing files cannot be repeated without limit.
  scope.counter.reads += 1
  const probe = await statFile(path, scope.fileSystem, scope.signal)
  if (probe.kind !== 'present') return undefined
  const left = scope.maxSourceBytes - scope.bytes
  if (probe.info.size !== undefined && probe.info.size > left) {
    scope.stopped = true
    return undefined
  }
  const content = await readBounded({ absolutePath: path, ...probe.info }, left, scope.fileSystem, scope.signal)
  if (content === undefined && probe.info.size === undefined) scope.stopped = true
  return content
}

async function expandWithin(
  content: string,
  absolutePath: string,
  scope: ImportScope,
  depth: number,
): Promise<string> {
  if (depth > MAX_IMPORT_DEPTH) return content
  const lines = content.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    out.push(line)
    if (scope.stopped) continue
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || !line.includes('@')) continue
    for (const match of maskInlineCode(line).matchAll(IMPORT_TOKEN)) {
      if (scope.stopped) break
      const reference = match[2]
      /* v8 ignore next -- the second group always participates in a match. */
      if (reference === undefined) continue
      const target = reference.startsWith('~/')
        ? join(homedir(), reference.slice(2))
        : resolve(dirname(absolutePath), reference)
      if (loadedByDiscovery(target, absolutePath, scope)) continue
      const real = await realOrSelf(target)
      if (scope.root !== undefined && scope.realRoot !== undefined
        && (!isInside(scope.root, target) || !isInside(scope.realRoot, real))) continue
      // A cycle, or a file this expansion already shows: repeating it would only multiply reads and text.
      if (scope.seen.has(real)) continue
      scope.seen.add(real)
      const imported = await readImport(target, scope)
      if (imported === undefined) continue
      const label = `\nImported from ${importDisplay(target, scope)}:\n\n`
      scope.bytes += Buffer.byteLength(imported, 'utf8') + Buffer.byteLength(label, 'utf8') + 2
      if (scope.bytes > scope.maxSourceBytes) {
        scope.stopped = true
        break
      }
      const expanded = await expandWithin(imported, target, scope, depth + 1)
      out.push('', `Imported from ${importDisplay(target, scope)}:`, '', expanded.trimEnd(), '')
    }
  }
  return out.join('\n')
}

/**
 * The real user-global instruction file: `AGENTS.md` in the harness home. Only it may import files outside a
 * project, so a project file whose displayed path merely looks global (a folder named `~` or `$DSH_HOME`
 * inside the repository) gets project rules.
 * @param homes - the resolved harness home.
 * @returns its absolute instruction-file path.
 */
export function userGlobalInstructionFiles(homes: { dshHome: string }): string[] {
  return [resolve(join(homes.dshHome, USER_GLOBAL_FILE))]
}

/** Options for {@link expandInstructionImports}. */
export interface InstructionImportOptions {
  /** Root that bounds imports from project files. */
  projectRoot: string
  /** Absolute paths of the real user-global instruction files ({@link userGlobalInstructionFiles}); any other file is a project file. */
  globalFiles: readonly string[]
  /** Per-file source cap, applied to the file and its imports together, while they are read. */
  maxSourceBytes: number
  /** Optional provider used instead of host filesystem reads. */
  fileSystem?: FileSystem
  /** Cancellation for probes and reads. */
  signal?: AbortSignal
  /** Read count shared across one load; a fresh one caps this file alone. */
  counter?: ImportReadCounter
}

/**
 * Expand Claude Code-style `@path` imports in an instruction file. Each import
 * keeps its reference line and adds the imported file's content after it,
 * labelled with its path; nested imports expand up to {@link MAX_IMPORT_DEPTH}
 * levels, and a file already imported in this expansion (a cycle, or the same
 * file named twice) is not read or shown again. References inside fenced or
 * inline code are left alone, and unreadable, missing, or disallowed files leave
 * the reference unchanged. A project instruction file may only import files
 * inside its project root (checked on the real path, so a symlink cannot
 * escape); the user-global files, recognized by their absolute path rather than
 * by how it is displayed, may import any readable file, because the user wrote
 * them. The per-file source cap is enforced while reading, so expansion stops
 * before the first import that would exceed it, and one load reads at most
 * {@link MAX_IMPORT_READS} imported files.
 * @param file - the loaded instruction file.
 * @param options - project root, global files, byte cap, provider, cancellation and shared read count.
 * @returns the file with its imports expanded.
 */
export async function expandInstructionImports(
  file: LoadedInstructionFile,
  options: InstructionImportOptions,
): Promise<LoadedInstructionFile> {
  if (!file.content.includes('@')) return file
  const global = options.globalFiles.some(path => resolve(path) === resolve(file.absolutePath))
  const root = global ? undefined : resolve(options.projectRoot)
  const realRoot = root === undefined ? undefined : await realOrSelf(root)
  const scope: ImportScope = {
    root,
    realRoot,
    displayRoot: root,
    maxSourceBytes: options.maxSourceBytes,
    fileSystem: options.fileSystem,
    signal: options.signal,
    counter: options.counter ?? { reads: 0 },
    seen: new Set([await realOrSelf(file.absolutePath)]),
    bytes: Buffer.byteLength(file.content, 'utf8'),
    stopped: false,
  }
  const content = await expandWithin(file.content, file.absolutePath, scope, 1)
  return content === file.content ? file : { ...file, content }
}

/**
 * Drop later candidates whose trimmed content duplicates an earlier candidate in
 * the same candidate group. Different groups never collapse even when identical;
 * within one group the earliest candidate in discovery order is kept and its
 * original bytes are rendered. The two user-global roots form one group, so a
 * shared file matching the harness-home content collapses behind it. A candidate
 * that symlinks a sibling resolves to the same content and collapses here like
 * any byte-identical real file.
 * @param files - loaded files in discovery order.
 * @returns the retained files in the same order.
 */
export function dedupInstructionFilesByCandidateGroup(files: LoadedInstructionFile[]): LoadedInstructionFile[] {
  const keptDigestsByGroup = new Map<string, Set<string>>()
  const kept: LoadedInstructionFile[] = []
  for (const file of files) {
    const group = instructionCandidateGroup(scopeForDisplayPath(file.displayPath))
    let digests = keptDigestsByGroup.get(group)
    if (digests === undefined) {
      digests = new Set()
      keptDigestsByGroup.set(group, digests)
    }
    const digest = instructionDuplicateKey(file.displayPath, file.content)
    if (digests.has(digest)) continue
    digests.add(digest)
    kept.push(file)
  }
  return kept
}

/**
 * Discover, read, and render the baseline instruction chain.
 * @param options - discovery, source-size, byte-budget, and cancellation configuration.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns rendered baseline context, or undefined when nothing can be loaded.
 * @throws the original root-marker metadata error or cancellation reason when
 * discovery cannot identify the project root.
 */
export async function loadBaselineInstructions(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedAgentInstructions | undefined> {
  return (await loadBaselineInstructionSet(options, fileSystem))?.rendered
}

/**
 * Load a baseline together with the files retained after rendering.
 * @param options - discovery, source-size, byte-budget, and cancellation configuration.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns rendered context and retained files, an explicit empty replacement set, or undefined when empty or disabled.
 */
export async function loadBaselineInstructionSet(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedInstructionSet | undefined> {
  const config = resolveConfig(options)
  if (config.maxBytes <= 0 || !Number.isFinite(config.maxBytes)) return undefined
  if (config.maxSourceBytes <= 0 || !Number.isFinite(config.maxSourceBytes)) return undefined
  const discovered = await discoverInstructionFiles(options, fileSystem)
  const importRoot = options.projectRoot
    ?? await findProjectRoot(resolve(options.cwd), config.projectRootMarkers, fileSystem, options.signal)
  const imports: InstructionImportOptions = {
    projectRoot: importRoot,
    // The same homes discovery used, so the files it found as user-global are the ones recognized here.
    globalFiles: userGlobalInstructionFiles(resolveDiscoveryConfig(options)),
    maxSourceBytes: config.maxSourceBytes,
    ...fileSystem === undefined ? {} : { fileSystem },
    ...options.signal === undefined ? {} : { signal: options.signal },
    counter: { reads: 0 },
  }
  const loaded: LoadedInstructionFile[] = []
  for (const file of discovered) {
    const content = await readBounded(file, config.maxSourceBytes, fileSystem, options.signal)
    if (content !== undefined) {
      loaded.push(await expandInstructionImports({
        absolutePath: file.absolutePath,
        displayPath: file.displayPath,
        content,
        ...file.version === undefined ? {} : { version: file.version },
      }, imports))
    }
  }
  const kept = dedupInstructionFilesByCandidateGroup(loaded)
  if (kept.length === 0) {
    if (options.replacePreviousBaseline !== true) return undefined
    const { rendered, included } = renderAgentInstructionSet([], {
      maxBytes: config.maxBytes,
      replacePreviousBaseline: true,
    })
    return {
      rendered,
      observed: [],
      deduped: [],
      included,
    }
  }
  const keptPaths = new Set(kept.map(file => file.absolutePath))
  const { rendered, included } = renderAgentInstructionSet(kept, {
    maxBytes: config.maxBytes,
    ...options.replacePreviousBaseline === undefined
      ? {}
      : { replacePreviousBaseline: options.replacePreviousBaseline },
  })
  return {
    rendered,
    observed: loaded,
    deduped: loaded.filter(file => !keptPaths.has(file.absolutePath)),
    included,
  }
}

/**
 * Resolve the file and display paths for one logical instruction candidate.
 * @param scope - candidate scope key containing its directory and file name.
 * @param projectRoot - root used for project-relative candidates.
 * @param resolved - normalized homes used for user-global candidates.
 * @returns the absolute and model-facing paths for the candidate.
 * @internal
 */
export function scopeInstructionFile(
  scope: string,
  projectRoot: string,
  resolved: ResolvedDiscoveryConfig,
): InstructionFile {
  const { directory, candidateName } = decodeScopeKey(scope)
  const globalRoot = userGlobalRoots(resolved).find(root => root.directory === directory)
  const dir = globalRoot?.home ?? (directory === '.' ? projectRoot : join(projectRoot, directory))
  const absolutePath = join(dir, candidateName)
  return {
    absolutePath,
    displayPath: globalRoot === undefined ? relativeDisplay(projectRoot, absolutePath) : `${globalRoot.display}/${candidateName}`,
  }
}

/**
 * Probe the current provider metadata for one per-candidate instruction scope.
 * @param scope - a {@link candidateScopeKey} identifying a directory and candidate file.
 * @param projectRoot - project root used to resolve and display project scopes.
 * @param resolved - normalized plugin configuration.
 * @param fileSystem - provider used to resolve and stat scope candidates.
 * @param signal - cancellation for provider probes.
 * @returns present metadata, confirmed absence, or temporary unavailability.
 */
export async function probeScopeInstruction(
  scope: string,
  projectRoot: string,
  resolved: ResolvedConfig,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<ScopeInstructionProbe> {
  const candidate = scopeInstructionFile(scope, projectRoot, resolved)
  // resolve() follows a final-component symlink; stat then classifies the target.
  // A non-file target (missing, or a link to a directory) is a confirmed absence;
  // only a provider exception is reported as unavailable.
  let target: FsTarget
  let info: FsInfo | undefined
  try {
    target = await fileSystem.resolve(candidate.absolutePath, signalOptions(signal))
    info = await fileSystem.stat(target, signal)
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
  if (info?.type !== 'file') return { kind: 'absent' }
  const file: ProbedInstructionFile = {
    ...candidate,
    target,
    version: info.version,
    ...info.size === undefined ? {} : { size: info.size },
  }
  return { kind: 'present', file }
}

/**
 * Read one already-probed scope candidate under the configured source cap.
 * @param file - winning provider candidate and its metadata snapshot.
 * @param maxSourceBytes - maximum UTF-8 bytes accepted from the source.
 * @param fileSystem - provider used for the streaming read.
 * @param signal - cancellation for provider streaming.
 * @param imports - project root and global files that bound `@path` imports; omitted reads the file without expanding imports.
 * @returns loaded content with the probed version, or undefined when unavailable.
 */
export async function readScopeInstruction(
  file: ProbedInstructionFile,
  maxSourceBytes: number,
  fileSystem: FileSystem,
  signal?: AbortSignal,
  imports?: { projectRoot: string; globalFiles: readonly string[] },
): Promise<LoadedInstructionFile | undefined> {
  const content = await readBounded(file, maxSourceBytes, fileSystem, signal)
  if (content === undefined) return undefined
  const loaded = {
    absolutePath: file.absolutePath,
    displayPath: file.displayPath,
    content,
    version: file.version,
  }
  return imports === undefined ? loaded : expandInstructionImports(loaded, {
    ...imports,
    maxSourceBytes,
    fileSystem,
    ...signal === undefined ? {} : { signal },
  })
}
