/**
 * Minimal standard 5-field cron parser (no seconds field) for the scheduler.
 * Supports wildcard, step, exact, range, and list values in each field
 * (e.g. any, step every n, a single n, a-b range, and comma-separated lists).
 * Field order: minute hour day-of-month month day-of-week (0-6, 0=Sunday).
 * @module @deepseek-ai/dsh-scheduler-host
 */

const RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
} as const

export interface CronSchedule {
  readonly minute: ReadonlySet<number>
  readonly hour: ReadonlySet<number>
  readonly dom: ReadonlySet<number>
  readonly month: ReadonlySet<number>
  readonly dow: ReadonlySet<number>
}

export class CronError extends Error {}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i)
      continue
    }
    if (part.startsWith('*/')) {
      const step = Number(part.slice(2))
      if (!Number.isInteger(step) || step < 1) {
        throw new CronError(`invalid cron field: ${part}`)
      }
      for (let i = min; i <= max; i += step) values.add(i)
      continue
    }
    const m = /^(\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part)
    if (m === null) throw new CronError(`invalid cron field: ${part}`)
    let start = Number(m[1])
    const end = m[2] === undefined ? (m[3] === undefined ? start : max) : Number(m[2])
    const step = m[3] === undefined ? 1 : Number(m[3])
    if (start < min || end > max || start > end || step < 1) {
      throw new CronError(`cron field out of range: ${part}`)
    }
    for (let i = start; i <= end; i += step) values.add(i)
  }
  return values
}

/** Parse a 5-field cron expression, throwing {@link CronError} on bad input. */
export function parseCron(expr: string): CronSchedule {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronError('cron must have exactly 5 fields: minute hour day-of-month month day-of-week')
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string]
  return {
    minute: parseField(minute, RANGES.minute[0], RANGES.minute[1]),
    hour: parseField(hour, RANGES.hour[0], RANGES.hour[1]),
    dom: parseField(dom, RANGES.dom[0], RANGES.dom[1]),
    month: parseField(month, RANGES.month[0], RANGES.month[1]),
    dow: parseField(dow, RANGES.dow[0], RANGES.dow[1]),
  }
}

/**
 * Compute the next minute at or after `from` (exclusive of the current minute)
 * matching the schedule. Steps minute-by-minute up to one year, then throws.
 * Day-of-month and day-of-week are ANDed (both must match).
 */
export function nextRun(schedule: CronSchedule, from: Date): Date {
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMilliseconds(0)
  d.setMinutes(d.getMinutes() + 1)
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (schedule.minute.has(d.getMinutes())
      && schedule.hour.has(d.getHours())
      && schedule.dom.has(d.getDate())
      && schedule.month.has(d.getMonth() + 1)
      && schedule.dow.has(d.getDay())) {
      return d
    }
    d.setMinutes(d.getMinutes() + 1)
  }
  throw new CronError('no next run within one year')
}

/** Human-readable summary of one cron expression, e.g. every-5-minutes -> `every 5 minutes`. */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [minute, hour, , , dow] = parts
  if (minute !== undefined && minute.startsWith('*/') && hour === '*' && dow === '*') {
    const step = Number(minute.slice(2))
    if (Number.isInteger(step) && step > 0) return `every ${step} minute${step === 1 ? '' : 's'}`
  }
  return expr
}
