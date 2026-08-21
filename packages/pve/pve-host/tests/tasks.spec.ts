/**
 * Unit tests for the PVE task-index parser: line parsing (both observed
 * status shapes), UPID dedup across runs, rotation detection, and state
 * trimming.
 */
import { describe, expect, it } from 'vitest'
import {
  countLines,
  diffNewFailedTasks,
  indexRotated,
  parseTaskIndex,
  parseTaskLine,
  trimProcessed,
} from '../src/tasks.ts'

/** A realistic index line: UPID + tab-separated trailing fields ending in status. */
const OK_LINE = 'UPID:pve:0000ABCD:0009A3F5:660D1B2A:vzdump:100:root@pam:\tbackup vm 100\tOK'
const FAIL_LINE = 'UPID:pve:0000ABCE:0009A3F5:660D1B2B:qmigrate:101:root@pam:\tmigrate failed\tcommand failed with exit code 255'
/** Older Proxmox builds emit JSON status tails. */
const FAIL_JSON_LINE = 'UPID:pve:0000ABCF:0009A3F5:660D1B2C:vzdump:102:root@pam:\t{"exitcode":255,"status":"unable to lock VM 102"}'

describe('parseTaskLine', () => {
  it('parses an OK task', () => {
    const entry = parseTaskLine(OK_LINE)
    expect(entry).not.toBeNull()
    expect(entry!.upid).toBe('UPID:pve:0000ABCD:0009A3F5:660D1B2A:vzdump:100:root@pam:')
    expect(entry!.ok).toBe(true)
    expect(entry!.type).toBe('vzdump')
    expect(entry!.target).toBe('100')
    expect(entry!.user).toBe('root@pam')
  })

  it('parses a failed task with plain-text status', () => {
    const entry = parseTaskLine(FAIL_LINE)
    expect(entry!.ok).toBe(false)
    expect(entry!.status).toBe('command failed with exit code 255')
    expect(entry!.type).toBe('qmigrate')
  })

  it('parses a failed task with JSON status tail (status = last non-empty field)', () => {
    const entry = parseTaskLine(FAIL_JSON_LINE)
    expect(entry!.ok).toBe(false)
    expect(entry!.status).toContain('unable to lock VM 102')
  })

  it('returns null for lines without a UPID', () => {
    expect(parseTaskLine('')).toBeNull()
    expect(parseTaskLine('garbage line without upid')).toBeNull()
  })

  it('treats a UPID with no trailing fields as failed (unknown status)', () => {
    const entry = parseTaskLine('UPID:pve:0001:0002:660D1B2A:backup:103:root@pam:')
    expect(entry).not.toBeNull()
    expect(entry!.ok).toBe(false)
    expect(entry!.status).toBe('')
  })
})

describe('parseTaskIndex', () => {
  it('parses every UPID-bearing line in order', () => {
    const entries = parseTaskIndex([OK_LINE, FAIL_LINE, '', 'noise'].join('\n'))
    expect(entries).toHaveLength(2)
    expect(entries[0]!.ok).toBe(true)
    expect(entries[1]!.ok).toBe(false)
  })
})

describe('diffNewFailedTasks', () => {
  it('reports each failed task exactly once across runs', () => {
    const entries = parseTaskIndex([OK_LINE, FAIL_LINE, FAIL_JSON_LINE].join('\n'))
    const first = diffNewFailedTasks(entries, [])
    expect(first.fresh.map(t => t.upid)).toEqual([entries[1]!.upid, entries[2]!.upid])

    // Second run over the SAME file: nothing new.
    const second = diffNewFailedTasks(entries, first.nextProcessed)
    expect(second.fresh).toHaveLength(0)
    expect(second.nextProcessed).toHaveLength(first.nextProcessed.length)
  })

  it('does not report OK tasks even when unseen', () => {
    const entries = parseTaskIndex([OK_LINE].join('\n'))
    const result = diffNewFailedTasks(entries, [])
    expect(result.fresh).toHaveLength(0)
  })

  it('reports a failed task that appears in a later run (missed first time)', () => {
    const run1 = diffNewFailedTasks(parseTaskIndex([OK_LINE].join('\n')), [])
    const run2 = diffNewFailedTasks(parseTaskIndex([OK_LINE, FAIL_LINE].join('\n')), run1.nextProcessed)
    expect(run2.fresh.map(t => t.upid)).toEqual([FAIL_LINE.split('\t')[0]])
  })
})

describe('rotation detection', () => {
  it('detects a shrinking index as rotation', () => {
    expect(indexRotated(3, 120)).toBe(true)
  })
  it('treats growth or stability as no rotation', () => {
    expect(indexRotated(130, 120)).toBe(false)
    expect(indexRotated(120, 120)).toBe(false)
  })
  it('never flags the first run', () => {
    expect(indexRotated(0, 0)).toBe(false)
  })
})

describe('trimProcessed', () => {
  it('keeps the newest entries only', () => {
    const upids = Array.from({ length: 600 }, (_, i) => `UPID:x:${i}`)
    const trimmed = trimProcessed(upids, 500)
    expect(trimmed).toHaveLength(500)
    expect(trimmed[0]).toBe('UPID:x:100')
    expect(trimmed[499]).toBe('UPID:x:599')
  })
  it('returns a copy when under the bound', () => {
    const upids = ['a', 'b']
    const trimmed = trimProcessed(upids, 500)
    expect(trimmed).toEqual(['a', 'b'])
    expect(trimmed).not.toBe(upids)
  })
})

describe('countLines', () => {
  it('counts non-empty lines', () => {
    expect(countLines([OK_LINE, '', FAIL_LINE, '  '].join('\n'))).toBe(2)
  })
})
