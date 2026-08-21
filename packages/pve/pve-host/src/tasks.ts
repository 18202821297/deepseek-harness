/**
 * Parser for Proxmox VE's `/var/log/pve/tasks/index` files. Each line is a
 * UPID followed by tab-separated trailing fields; the LAST non-empty field
 * is the task's end status (`OK` on success, anything else — usually the
 * error text or an exit-code JSON — marks a failed task). The parser is
 * deliberately tolerant: it extracts the UPID by pattern and treats any
 * non-`OK` trailing status as a failure, so exact per-version field layout
 * differences do not silently drop alerts.
 * @module @deepseek-ai/dsh-pve-host/src/tasks
 */

/** One parsed task index line. */
export interface PveTaskEntry {
  /** The full UPID string — the stable dedup key. */
  readonly upid: string
  /** True when the trailing status is exactly `OK`. */
  readonly ok: boolean
  /** The raw trailing status text (error message for failed tasks, `OK` else). */
  readonly status: string
  /** The task type segment of the UPID (e.g. `vzdump`, `backup`), may be empty. */
  readonly type: string
  /** The task target id segment of the UPID (e.g. a VMID), may be empty. */
  readonly target: string
  /** The originating user segment of the UPID, may be empty. */
  readonly user: string
}

/** Match `UPID:<node>:<pid>:<pstart>:<starttime>:<type>:<id>:<user>[:...]`. */
const UPID_RE = /^UPID:\S+/

/** Split a UPID into its colon-separated segments. */
function upidSegments(upid: string): string[] {
  return upid.split(':')
}

/**
 * Parse one index line into a task entry.
 * @param line raw line from an `index` / `index.1` file
 * @returns the entry, or null when the line carries no UPID.
 */
export function parseTaskLine(line: string): PveTaskEntry | null {
  const trimmed = line.replace(/\r$/, '')
  if (trimmed.length === 0) return null
  const match = UPID_RE.exec(trimmed)
  if (match === null) return null
  const upid = match[0]
  // Trailing fields follow the UPID, tab-separated; the last non-empty one
  // is the end status.
  const rest = trimmed.slice(upid.length).split('\t')
  const fields = rest.map(f => f.trim()).filter(f => f.length > 0)
  const status = fields.length > 0 ? fields[fields.length - 1] ?? '' : ''
  const seg = upidSegments(upid)
  return {
    upid,
    ok: status === 'OK',
    status,
    // UPID:<node>:<pid>:<pstart>:<starttime>:<type>:<id>:<user>[:extras]
    type: seg[5] ?? '',
    target: seg[6] ?? '',
    user: seg[7] ?? '',
  }
}

/**
 * Parse a whole index file body.
 * @param raw file content (newline-separated lines)
 * @returns entries for lines that carry a UPID, in file order.
 */
export function parseTaskIndex(raw: string): PveTaskEntry[] {
  const entries: PveTaskEntry[] = []
  for (const line of raw.split('\n')) {
    const entry = parseTaskLine(line)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

/**
 * Split parsed entries into new-failed vs already-reported, then return the
 * merged next state. Dedup is by exact UPID: a task is reported at most once
 * across runs, which is what makes the at-most-once delivery guarantee safe
 * even when collection runs every few minutes.
 * @param entries all entries parsed from `index` (plus `index.1` on rotation)
 * @param processedUpids UPIDs already reported in earlier runs
 * @returns failed tasks never reported before, and the next processed set
 */
export function diffNewFailedTasks(
  entries: readonly PveTaskEntry[],
  processedUpids: readonly string[],
): { fresh: PveTaskEntry[]; nextProcessed: string[] } {
  const seen = new Set(processedUpids)
  const fresh: PveTaskEntry[] = []
  for (const entry of entries) {
    if (entry.ok) continue
    if (seen.has(entry.upid)) continue
    seen.add(entry.upid)
    fresh.push(entry)
  }
  return { fresh, nextProcessed: [...seen] }
}

/**
 * Detect index-file rotation: when the current file has (many) fewer lines
 * than the previous run saw, `index` was rotated to `index.1` and entries
 * that lived at the tail of the old file now live only in `index.1`.
 * @param currentLines line count of the current `index` file
 * @param lastLines line count seen in the previous run (0 on first run)
 * @returns true when a rotation likely happened and `index.1` should be read too
 */
export function indexRotated(currentLines: number, lastLines: number): boolean {
  if (lastLines === 0) return false
  return currentLines < lastLines
}

/** Count non-empty lines of a file body (rotation heuristic input). */
export function countLines(raw: string): number {
  let n = 0
  for (const line of raw.split('\n')) {
    if (line.trim().length > 0) n++
  }
  return n
}

/**
 * Trim the processed-UPID set to the newest `max` entries. UPIDs embed a
 * unix start time, so older entries can never reappear; dropping them keeps
 * the persisted state bounded without breaking dedup.
 * @param upids the full processed set (insertion-ordered, newest last)
 * @param max bound to keep
 */
export function trimProcessed(upids: readonly string[], max: number): string[] {
  return upids.length <= max ? [...upids] : upids.slice(upids.length - max)
}
