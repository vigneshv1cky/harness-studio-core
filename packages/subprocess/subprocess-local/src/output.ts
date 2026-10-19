/** Bounded output tails and private spill files shared by process providers. */
import { randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, readSync, renameSync, rmdirSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CollectedOutput } from '@deepseek-ai/dsh-subprocess'

/**
 * Receives one spill failure so the owner can log it through its own logger.
 * Called at most once per collector, after the spill has been discarded and
 * the in-memory tail has kept collecting. A reporter that throws is contained
 * and its failure written to stderr.
 * @param error - the `node:fs` failure from opening or appending the spill file.
 * @param label - the stream label of the collector that failed.
 */
export type SpillFailureReporter = (error: unknown, label: string) => void

/** Spill storage for one collected stream; `undefined` means tail-only collection. */
export interface SpillOptions {
  /**
   * Spill file byte cap. A longer stream keeps its first half and its last half in the file, with a line
   * saying how many bytes between them were left out.
   */
  maxBytes: number
  /** Private directory receiving the spill file. */
  dir: string
  /** Owner-side report of a spill open or write failure. */
  onFailure: SpillFailureReporter
}

let spillCounter = 0
let defaultSpillDir: string | undefined

/**
 * The default spill location: a private (0700) per-process directory under
 * the OS tmpdir, created lazily. Predictable world-readable paths would let
 * other local users read command output or pre-create symlinks. The directory
 * is created once per process and never recreated: when an external
 * temporary-file cleaner removes it while empty, the next spill open fails and
 * the collector degrades to its in-memory tail. At a JavaScript-observable
 * process exit the directory is removed only when it holds no completed spill
 * file (spill files are retained as full-output recovery artifacts until an
 * external cleanup).
 */
function privateSpillDir(): string {
  defaultSpillDir ??= mkdtempSync(join(tmpdir(), 'dsh-subprocess-'))
  return defaultSpillDir
}

/** Spill files this process created that still exist; removed when the process exits. */
const liveSpillFiles = new Set<string>()

/**
 * Remove spill files. Output logs hold command output, which can be large (tens of megabytes) and can hold
 * whatever a command printed, so they do not outlive the process that made them, nor a discarded job.
 * @param files - the spill paths to remove; omitted removes every one this process created.
 */
export function removeSpillFiles(files: Iterable<string> = [...liveSpillFiles]): void {
  for (const file of files) {
    if (!liveSpillFiles.has(file)) continue
    liveSpillFiles.delete(file)
    try { unlinkSync(file) } catch { /* already gone */ }
  }
}

// At a JavaScript-observable process exit every spill file this process created is removed, then the
// per-process directory, which is empty by then. A SIGKILLed process cannot run this at all; its residue is
// left to OS temp hygiene.
/* v8 ignore next 5 -- exit listeners run after the coverage dump; removal is verified by the CI /tmp residue measurement. */
process.once('exit', () => {
  removeSpillFiles()
  if (defaultSpillDir === undefined) return
  try { rmdirSync(defaultSpillDir) } catch { /* best-effort: ENOENT/ENOTEMPTY/EBUSY/EPERM must not change the exit code. */ }
})

/**
 * The stderr reporter used when no owner supplies one: a bare
 * {@link prepareManagedProcessBinding} caller has no plugin logger, and the
 * failure must still reach the process diagnostics.
 * @param error - the spill failure.
 * @param label - the failed stream label.
 */
function reportSpillFailureToStderr(error: unknown, label: string): void {
  process.stderr.write(`dsh-subprocess-local: ${label} spill failed; only the in-memory tail is retained: ${String(error)}\n`)
}

/**
 * Build the reporter an owner passes as {@link SpillOptions.onFailure}: one
 * error-level log line naming the owner and stream, with the failure appended
 * so its `code`, `syscall`, and `path` reach the log.
 * @param logger - the owner's plugin logger.
 * @param owner - the component named in the line.
 * @returns the reporter.
 */
export function logSpillFailure(logger: { error(message: string, ...detail: unknown[]): void }, owner: string): SpillFailureReporter {
  return (error, label) => {
    const removedDirectory = (error as NodeJS.ErrnoException).code === 'ENOENT'
    logger.error(
      `${owner} could not write the complete ${label} stream to its spill file; the result keeps only the in-memory tail and reports no full-output path.`
      + (removedDirectory ? ' The spill directory no longer exists; a temporary-file cleaner removing it while empty is the usual cause.' : ''),
      error,
    )
  }
}

/** Inputs a managed native process needs before its output streams are bound. */
export interface ManagedProcessBinding {
  /** Directory receiving spill files. */
  spillDir: string
  /** Receives a spill open or write failure. */
  onSpillFailure: SpillFailureReporter
}

/**
 * Prepare fallible output storage before starting a managed native process.
 * This is the explicit resolve step for spill inputs: the spill directory
 * defaults to the private per-process directory, and the failure reporter
 * defaults to a stderr line when the caller has no logger.
 * @param internals - optional caller-owned spill directory and failure reporter.
 * @returns binding inputs whose spill directory is ready for use.
 */
export function prepareManagedProcessBinding(
  internals: { spillDir?: string; onSpillFailure?: SpillFailureReporter } = {},
): ManagedProcessBinding {
  return {
    spillDir: internals.spillDir ?? privateSpillDir(),
    onSpillFailure: internals.onSpillFailure ?? reportSpillFailureToStderr,
  }
}


/**
 * Collects one stream with a bounded in-memory tail. With spill options, on
 * first overflow a spill file is created and every chunk (including those
 * already collected) is appended there while the full stream remains within
 * the cap; without them, only the in-memory tail is ever retained (the
 * diagnostic-tail shape — a language server's stderr).
 *
 * Spilling is best-effort: a spill open or write failure discards the spill,
 * reports once through {@link SpillOptions.onFailure}, and never interrupts
 * in-memory collection, because `push()` runs inside the stream's `'data'`
 * listener where a thrown error would become an uncaught exception.
 *
 * Tail-keep rationale (pi/OpenCode): errors and final results cluster at the
 * end of command output; the spill file covers the head.
 */
export class OutputCollector {
  private chunks: Buffer[] = []
  private bytes = 0
  private dropped = false
  private spillFd: number | undefined
  private spillFile: string | undefined
  private spillDisabled: boolean
  /** Total bytes ever pushed (not just retained). */
  private total = 0
  /** Stream bytes written to the spill file so far (its first `min(total, cap)` positions, then the tail ring). */
  private spilled = 0
  /** Set once the seal rearranged a wrapped spill into head, omission line and tail. */
  private sealed = false

  /**
   * @param maxBytes - in-memory tail cap in bytes.
   * @param label - stream label used in spill file names and failure reports.
   * @param spill - spill storage; omit for tail-only collection.
   */
  constructor(
    private readonly maxBytes: number,
    private readonly label: string,
    private readonly spill: SpillOptions | undefined,
  ) {
    this.spillDisabled = spill === undefined
  }

  /**
   * Ingest one stream chunk, counting it toward the whole-stream total. On
   * first overflow of the in-memory cap a spill file is opened (when spilling
   * is enabled) and every chunk (already-collected ones included) is appended
   * there from then on; the in-memory tail then drops whole chunks from its
   * head (or the head of a single over-cap chunk) until it fits the cap again.
   * @param chunk - the raw bytes from one stream 'data' event.
   */
  push(chunk: Buffer): void {
    this.total += chunk.length
    const overflows = this.bytes + chunk.length > this.maxBytes
    const spill = this.spill
    if (spill !== undefined && !this.spillDisabled && (overflows || this.spillFd !== undefined)) this.spillAll(spill, chunk)
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        // Drop the whole head chunk (length ≥ 1 is guaranteed while over cap).
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        // Trim the head so the retained window is byte-exact at the cap — a
        // diagnostic tail (an LSP server's stderr) must hold the LAST
        // maxBytes regardless of how the stream was chunked.
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
      this.dropped = true
    }
  }

  /**
   * Open the spill file lazily and append `chunk` (and any prior chunks once).
   * Runs inside the stream's `'data'` listener, so every filesystem failure is
   * contained here: the spill is discarded, reported once, and collection
   * continues with the in-memory tail alone.
   */
  private spillAll(spill: SpillOptions, chunk: Buffer): void {
    // Below two bytes there is no room for both a head and a tail: keep the old discard.
    if (this.total > spill.maxBytes && spill.maxBytes < 2) {
      this.discardSpill()
      return
    }
    try {
      if (this.spillFd === undefined) {
        // Random suffix + O_EXCL + no-follow-equivalent ('wx' fails on any
        // existing path, symlink or not) + owner-only mode: defeats spill-path
        // prediction and symlink planting in shared tmp dirs. The path is
        // published only once the open succeeded, so a failed open (EEXIST on a
        // planted entry included) never lets discardSpill unlink a path this
        // process did not create.
        const file = join(
          spill.dir,
          `dsh-subprocess-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`,
        )
        const fd = openSync(file, 'wx', 0o600)
        this.spillFile = file
        this.spillFd = fd
        liveSpillFiles.add(file)
        for (const prior of this.chunks) this.spillWrite(spill.maxBytes, prior)
      }
      this.spillWrite(spill.maxBytes, chunk)
    } catch (error) {
      // ENOENT (spill directory removed by a temp cleaner), EACCES/EPERM,
      // EMFILE, or ENOSPC: the spill file is a recovery aid, not a
      // precondition of collection.
      this.discardSpill()
      try {
        spill.onFailure(error, this.label)
      } catch (reporterFailure) {
        // The reporter runs inside the stream listener too; a failing logger
        // must not become the uncaught exception this path exists to prevent.
        process.stderr.write(`dsh-subprocess-local: spill failure reporter threw: ${String(reporterFailure)}\n`)
      }
    }
  }

  /**
   * Append stream bytes to the spill file within its cap. The first half of the cap holds the stream's head;
   * the second half is a ring holding its tail: stream byte `p` past the head lands at
   * `head + (p - head) % tail`, which is `p` itself until the stream outgrows the cap, so a stream within the
   * cap is written exactly as before. {@link seal} puts a wrapped ring back in order.
   */
  private spillWrite(cap: number, chunk: Buffer): void {
    const fd = this.spillFd as number
    const head = Math.floor(cap / 2)
    const tail = cap - head
    let data = chunk
    let position = this.spilled
    this.spilled += chunk.length
    // Bytes that will be overwritten within this same chunk need not be written.
    if (position >= head && data.length > tail) {
      position += data.length - tail
      data = data.subarray(data.length - tail)
    }
    while (data.length > 0) {
      const offset = position < head ? position : head + ((position - head) % tail)
      const room = position < head ? head - position : head + tail - offset
      const piece = data.subarray(0, Math.min(room, data.length))
      writeSync(fd, piece, 0, piece.length, offset)
      position += piece.length
      data = data.subarray(piece.length)
    }
  }

  /** Bytes the spill file leaves out between its head and tail: zero while the stream fits its cap. */
  private omittedBytes(): number {
    const cap = this.spill?.maxBytes ?? 0
    return this.spillFile === undefined || this.spilled <= cap ? 0 : this.spilled - cap
  }

  /**
   * Rewrite a wrapped spill as head, one line naming how many bytes were left out, then the tail in order,
   * through a sibling file renamed over it, copying in bounded pieces.
   */
  private rearrangeSpill(cap: number): void {
    const file = this.spillFile as string
    const head = Math.floor(cap / 2)
    const tail = cap - head
    const start = head + ((this.spilled - head) % tail)
    const omitted = this.spilled - cap
    const ordered = `${file}.${randomBytes(4).toString('hex')}.tmp`
    const source = openSync(file, 'r')
    let target: number | undefined
    try {
      target = openSync(ordered, 'wx', 0o600)
      const piece = Buffer.allocUnsafe(Math.min(1024 * 1024, cap))
      const copy = (from: number, length: number): void => {
        for (let done = 0; done < length;) {
          const read = readSync(source, piece, 0, Math.min(piece.length, length - done), from + done)
          if (read === 0) throw new Error('spill file ended early')
          writeSync(target as number, piece, 0, read)
          done += read
        }
      }
      copy(0, head)
      writeSync(target, `\n[... ${omitted} bytes of output omitted: the output was ${this.spilled} bytes, more than the ${cap}-byte log keeps; this file holds its first ${head} and last ${tail} bytes ...]\n`)
      copy(start, head + tail - start)
      copy(head, start - head)
      closeSync(target)
      target = undefined
      renameSync(ordered, file)
    } catch (error) {
      if (target !== undefined) try { closeSync(target) } catch { /* reported below */ }
      try { unlinkSync(ordered) } catch { /* never created */ }
      throw error
    } finally {
      closeSync(source)
    }
  }

  /** Stop spilling and remove the file once it can no longer hold the complete stream. */
  private discardSpill(): void {
    const fd = this.spillFd
    const file = this.spillFile
    this.spillFd = undefined
    this.spillFile = undefined
    this.spillDisabled = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Retain the descriptor so finalize can retry the failed close.
        this.spillFd = fd
      }
    }
    if (file !== undefined) {
      liveSpillFiles.delete(file)
      try {
        unlinkSync(file)
      } catch {
        // A failed unlink leaves at most maxSpillBytes behind, never an unbounded file.
      }
    }
  }

  /**
   * Incremental read in whole-stream byte coordinates: returns everything
   * pushed since `fromByte`. When `fromByte` has already slid out of the
   * in-memory tail window, the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the offset for the next read, the `lossy` flag, and the spill path when one was created.
   */
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string; spillOmittedBytes?: number } {
    const windowStart = this.total - this.bytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    const slice = lossy ? buffer : buffer.subarray(fromByte - windowStart)
    const omitted = this.omittedBytes()
    // A spill that outgrew its cap is a ring until the seal puts it in order: not worth reading before then.
    const spillPath = omitted === 0 || this.sealed ? this.spillFile : undefined
    return {
      text: slice.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...spillPath !== undefined ? { spillPath } : {},
      ...spillPath !== undefined && omitted > 0 ? { spillOmittedBytes: omitted } : {},
    }
  }

  /**
   * Copy the retained raw tail with its position in the complete observed stream.
   * @returns independent tail bytes and the total byte count before truncation.
   */
  snapshot(): { bytes: Buffer; totalBytes: number } {
    return { bytes: Buffer.concat(this.chunks), totalBytes: this.total }
  }

  /**
   * Close the spill file once the stream has ended. A failed close (delayed
   * writeback fault) stops advertising the spill path — the file may be
   * missing its tail — while every in-memory read keeps working. Idempotent;
   * the spawn path seals both collectors at settlement so reads after exit
   * never point at a still-open file.
   */
  seal(): void {
    if (this.spillFd === undefined) return
    try {
      closeSync(this.spillFd)
    } catch {
      // A delayed writeback failure makes the spill unreliable; keep the
      // in-memory result but stop advertising that file.
      this.spillFile = undefined
    }
    this.spillFd = undefined
    if (this.spillFile !== undefined && this.spill !== undefined && this.spilled > this.spill.maxBytes) {
      try {
        this.rearrangeSpill(this.spill.maxBytes)
      } catch (error) {
        const file = this.spillFile
        this.spillFile = undefined
        liveSpillFiles.delete(file)
        try { unlinkSync(file) } catch { /* reported below */ }
        try { this.spill.onFailure(error, this.label) } catch { /* contained, as in spillAll */ }
      }
    }
    this.sealed = true
  }

  /**
   * Seal the spill file and return the final output.
   * @returns the final collected output: tail text, truncation flag, and the spill path when intact.
   */
  finalize(): CollectedOutput {
    this.seal()
    const omitted = this.omittedBytes()
    return {
      text: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.dropped,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
      ...this.spillFile !== undefined && omitted > 0 ? { spillOmittedBytes: omitted } : {},
    }
  }

  /** Remove this stream's spill file now, as when its job is discarded. */
  removeSpill(): void {
    this.seal()
    const file = this.spillFile
    this.spillFile = undefined
    if (file !== undefined) removeSpillFiles([file])
  }
}
