/**
 * PVE collector Host service: manages monitored servers (PVE API token
 * secrets encrypted at rest), runs one collection on demand (`collectNow`),
 * and delivers new failed-task alerts through the message-channel (DingTalk)
 * Remote. No scheduling lives here — a future scheduler plugin calls the
 * same `collectNow` entry point.
 *
 * Delivery semantics (no missed, no duplicate alerts):
 *  1. dedup by exact task UPID (persisted per server),
 *  2. mark-then-send: the UPID is durably recorded BEFORE the alert is sent,
 *     so a send failure never causes a re-send on the next run (at-most-once
 *     per task, matching the source script's `cursor already saved` stance),
 *  3. index rotation fallback: a sudden line-count drop re-reads `index.1`,
 *  4. one in-flight collect per server: overlapping triggers are ignored.
 *
 * Persistence contract: `Service.init` opens the `pve` domain; every write is
 * durably committed before memory mutates.
 * @module @deepseek-ai/dsh-pve-host
 */

import { Service } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ServerRecord, TaskStateRecord } from './spec.ts'
import { pveDomainSpec, MAX_TRACKED_UPIDS, MAX_TRACKED_SYSLOG_HASHES } from './spec.ts'
import { decryptSecret, encryptSecret, maskSecret } from './cipher.ts'
import { realPveApiConnector, type PveApiClient, type PveApiConnector } from './api.ts'
import { parseApiTasks, diffNewFailedTasks, trimProcessed, type PveTaskEntry } from './tasks.ts'
import { registerPveAgentTools } from './agent-tools.ts'
import type {
  PveCollectRequest,
  PveCollectResult,
  PveCollectTestRequest,
  PveCollectTestResult,
  PveCollectTestTask,
  PveCollectTestValue,
  PveCollectValue,
  PveConfirmRequest,
  PveConfirmResult,
  PveConfirmValue,
  PveDeleteRequest,
  PveDeleteResult,
  PveDeleteValue,
  PveFailure,
  PveListModelsRequest,
  PveListModelsResult,
  PveListModelsValue,
  PveListRequest,
  PveListResult,
  PveListValue,
  PveModelGroup,
  PveSaveRequest,
  PveSaveResult,
  PveServer,
  PveSystemLogEntry,
  PveSetEnabledRequest,
  PveSetEnabledResult,
  PveSetEnabledValue,
} from './types.ts'

/** How many recent tasks to fetch from the PVE API per run (newest first). */
const TASKS_LIMIT = 500
/** How many raw log lines to fetch per failed task. */
const TASK_LOG_LIMIT = 500
/** Cap per-task log size fed downstream (chars); long logs are truncated. */
const RAW_LOG_MAX = 4000
/** Only fetch raw logs for the first N failed tasks (matches the scheduler's analysis cap). */
const LOG_FETCH_LIMIT = 50
/** Hard cap on syslog lines fetched per run (from the log tail). */
const SYSLOG_LIMIT = 300

/** Stable dedup key for a system-log line (no UPID exists). */
function syslogHash(ts: string, unit: string, message: string): string {
  const s = `${ts}|${unit}|${message}`
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return `h${(h >>> 0).toString(36)}`
}

/**
 * Normalize fancy hyphen variants (U+2010–U+2015, U+2212) that pasted text
 * often carries (e.g. the non-breaking hyphen U+2011) into a plain ASCII
 * `-`. Such characters make the `Authorization` header invalid and the PVE
 * API call fails with a cryptic HTTP-client error.
 */
function normalizeTokenId(id: string): string {
  return id.trim().replace(/[\u2010-\u2015\u2212]/g, '-')
}

/** Marks a line as error-ish (used for the coarse err/warning split). */
const SYSLOG_ERR_RE = /\b(error|failed|failure|fatal|critical|crit|panic|oops|abort|denied|refused)\b/i
/** Marks a line as alert-worthy at all — the PVE syslog API gives no level. */
const SYSLOG_ALERT_RE = /\b(error|failed|failure|fail|fatal|critical|crit|warning|warn|alert|abort|denied|refused|unable|cannot|panic|oops|timeout|timed\s*out|invalid|corrupt|degraded|down|out\s*of\s*memory|oom)\b/i
/** Routine noise that must never alert even when it matches a keyword. */
const SYSLOG_NOISE_RE = /(starting task|worker (started|finished|exit)|got inotify|starting \d+ worker|clearing outdated)/i

/**
 * Parse the `data` array from `GET /nodes/{node}/syslog`. PVE 8/9 returns
 * `{n, t}` with `t` a raw log line and NO level field, so alert-worthy lines
 * are detected by keyword; a structured `{l,c,m}` fallback is kept for other
 * API variants. `ts`/`unit` are parsed from the line when possible.
 */
function parseSyslogEntries(data: unknown): PveSystemLogEntry[] {
  const out: PveSystemLogEntry[] = []
  if (!Array.isArray(data)) return out
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const obj = item as Record<string, unknown>
    // Primary shape: { n, t } with t = full raw line.
    const line = typeof obj.t === 'string' ? obj.t.trim() : ''
    if (line.length > 0) {
      if (!SYSLOG_ALERT_RE.test(line)) continue
      if (SYSLOG_NOISE_RE.test(line)) continue
      // "Aug 25 16:34:39 pve pveproxy[2283001]: message"
      const m = line.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+\S+\s+(\S+)(?:\[(\d+)\])?:\s?(.*)$/)
      const name = m?.[2] ?? 'unknown'
      const pid = m?.[3]
      out.push({
        ts: m?.[1] ?? '',
        unit: pid !== undefined ? `${name}[${pid}]` : name,
        priority: SYSLOG_ERR_RE.test(line) ? 'err' : 'warning',
        message: m?.[4] ?? line,
      })
      continue
    }
    // Structured fallback: { l, c, m } (other API variants).
    const levelRaw = String(obj.l ?? '').toLowerCase()
    const numeric = /^\d+$/.test(levelRaw) ? Number(levelRaw) : NaN
    const isAlert = Number.isFinite(numeric)
      ? numeric <= 4
      : /^(emerg|alert|crit|critical|err|error|warning|warn)$/.test(levelRaw)
    if (!isAlert) continue
    const message = typeof obj.m === 'string' ? obj.m : String(obj.m ?? '')
    if (message.length === 0) continue
    const unit = typeof obj.c === 'string' && obj.c.length > 0 ? obj.c : 'unknown'
    out.push({ ts: '', unit, priority: /^(err|error|crit|critical|alert|emerg)$/.test(levelRaw) ? 'err' : 'warning', message })
  }
  return out
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pve: PveService
  }
}

/** Build a frozen success branch. */
function success<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/** Build a frozen rejected branch. */
function rejected<E extends PveFailure>(error: E): { ok: false; error: E } {
  return { ok: false, error }
}

/** The PVE server store, exposed as Remote `pve`. */
export class PveService extends TypertRemoteService {
  static inject = ['storageDomain', 'agents', 'tools']

  private table: KvTable<string, ServerRecord> | null = null
  private stateTable: KvTable<string, TaskStateRecord> | null = null
  private syslogStateTable: KvTable<string, import('./spec.ts').SyslogStateRecord> | null = null
  /** channelId → in-flight collect flag (overlapping runs are skipped). */
  private readonly collecting = new Set<string>()
  /** Injectable for tests; production uses the PVE API connector. */
  private readonly api: PveApiConnector
  /**
   * Test-only fake alert sender, kept for compatibility with existing specs;
   * production delivery moved to the scheduler plugin (collectOne no longer pushes).
   */
  readonly sender: (channelId: string, text: string) => Promise<boolean>

  constructor(ctx: import('@deepseek-ai/cordis').Context, options?: {
    api?: PveApiConnector
    sender?: (channelId: string, text: string) => Promise<boolean>
  }) {
    super(ctx, 'pve')
    this.api = options?.api ?? realPveApiConnector
    this.sender = options?.sender ?? (async (channelId, text) => {
      const dingtalk = ctx.reflect.get('dingtalk', false) as
        | { sendText(request: { id: string; content: string }): Promise<{ ok: boolean }> }
        | undefined
      if (dingtalk === undefined) return false
      try {
        const result = await dingtalk.sendText({ id: channelId, content: text })
        return result.ok
      } catch {
        return false
      }
    })
  }

  /** Open and own the pve domain (loads persisted servers). */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(pveDomainSpec)
    this.ctx.effect(() => () => void domain.close(), 'pve.domainClose')
    this.table = domain.table('servers')
    this.stateTable = domain.table('task_state')
    this.syslogStateTable = domain.table('syslog_state')
    // Expose the collector to agents: register PVE tools into every root agent.
    this.ctx.effect(() => registerPveAgentTools(this.ctx), 'pve.agentTools')
  }

  /** All servers, newest first. */
  @Remote('listServers')
  async listServers(_request: PveListRequest): Promise<PveListResult> {
    const table = this.requireTable()
    const servers: PveServer[] = [...table.entries()]
      .map(([, record]) => toServer(record))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const value: PveListValue = { servers }
    return success(value)
  }

  /** Create or replace one server; persists immediately. */
  @Remote('saveServer')
  async saveServer(request: PveSaveRequest): Promise<PveSaveResult> {
    const input = request.input
    this.ctx.logger.info(`[pve] saveServer id=${input.id} name=${input.name} apiUrl=${input.apiUrl} node=${input.node}`)
    if (!/^[\w-]+$/.test(input.id)) {
      return rejected({ code: 'invalid-input', message: 'server id must be alphanumeric, dash, or underscore' })
    }
    if (input.name.trim().length === 0 || input.apiUrl.trim().length === 0 || input.apiTokenId.trim().length === 0 || input.node.trim().length === 0) {
      return rejected({ code: 'invalid-input', message: 'server name, apiUrl, apiTokenId, and node are required' })
    }
    if (!/^https?:\/\//i.test(input.apiUrl.trim())) {
      return rejected({ code: 'invalid-input', message: 'apiUrl must start with http:// or https://' })
    }

    const table = this.requireTable()
    const now = new Date().toISOString()
    const existing = table.get(input.id)
    // Blank token secret on edit = keep the stored (encrypted) one unchanged.
    const storedSecret = input.apiTokenSecret !== undefined && input.apiTokenSecret.trim() !== ''
      ? encryptSecret(input.apiTokenSecret.trim())
      : existing?.apiTokenSecret ?? ''
    // Blank remark on edit = keep the stored value unchanged.
    const storedRemark = (input.remark !== undefined && input.remark.trim() !== '')
      ? input.remark.trim()
      : existing?.remark ?? ''

    const record: ServerRecord = {
      id: input.id,
      name: input.name.trim(),
      apiUrl: input.apiUrl.trim().replace(/\/+$/, ''),
      apiTokenId: normalizeTokenId(input.apiTokenId),
      apiTokenSecret: storedSecret,
      node: input.node.trim(),
      remark: storedRemark,
      enabled: input.enabled ?? existing?.enabled ?? true,
      systemLogEnabled: input.systemLogEnabled ?? existing?.systemLogEnabled ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await table.put(record.id, record)
    return success(toServer(record))
  }

  /** Delete one server; persists immediately. */
  @Remote('deleteServer')
  async deleteServer(request: PveDeleteRequest): Promise<PveDeleteResult> {
    if (!/^[\w-]+$/.test(request.id)) {
      return rejected({ code: 'invalid-input', message: 'server id must be alphanumeric, dash, or underscore' })
    }
    const table = this.requireTable()
    const stateTable = this.requireStateTable()
    const deleted = await table.delete(request.id)
    // State removal is opt-in: keeping it means a re-added server with the
    // same id will not re-fire its historical alerts; removing it re-arms them.
    if (request.removeState === true) {
      await stateTable.delete(request.id)
    }
    const value: PveDeleteValue = { deleted }
    return success(value)
  }

  /** Toggle a server's enabled flag (atomic read-modify-write). */
  @Remote('setEnabled')
  async setEnabled(request: PveSetEnabledRequest): Promise<PveSetEnabledResult> {
    const table = this.requireTable()
    const current = table.get(request.id)
    if (current === undefined) {
      const value: PveSetEnabledValue = { found: false }
      return success(value)
    }
    const next = await table.update(request.id, record => ({
      ...record,
      enabled: request.enabled,
      updatedAt: new Date().toISOString(),
    }))
    const value: PveSetEnabledValue = { found: true, server: toServer(next) }
    return success(value)
  }

  /**
   * Run one collection for a server: query the PVE API for recent tasks,
   * diff new failed tasks, mark them reported, then expose the fresh entries
   * for the scheduler to compose and deliver alerts.
   */
  @Remote('collectNow')
  async collectNow(request: PveCollectRequest): Promise<PveCollectResult> {
    const table = this.requireTable()
    const record = table.get(request.id)
    if (record === undefined) {
      return rejected({ code: 'server-not-found', message: `server '${request.id}' not found` })
    }
    if (this.collecting.has(request.id)) {
      const value: PveCollectValue = { reported: 0, skipped: 0, error: 'collection already in progress', systemLogs: [], systemReported: 0 }
      return success(value)
    }
    this.collecting.add(request.id)
    try {
      const value = await this.collectOne(record)
      return success(value)
    } finally {
      this.collecting.delete(request.id)
    }
  }

  /** List the harness model catalog for the AI-analysis dropdown. */
  @Remote('listModels')
  async listModels(_request: PveListModelsRequest): Promise<PveListModelsResult> {
    const llm = this.ctx.reflect.get('llm', false) as
      | {
        listConfigurableProviders(): { provider: string }[]
        listModels(provider: string): Promise<{ id: string }[]>
      }
      | undefined
    const groups: PveModelGroup[] = []
    if (llm !== undefined) {
      for (const provider of llm.listConfigurableProviders()) {
        try {
          const models = await llm.listModels(provider.provider)
          groups.push({ provider: provider.provider, models: models.map(m => m.id) })
        } catch {
          // A provider that cannot enumerate (no credentials, offline) is skipped.
        }
      }
    }
    const value: PveListModelsValue = { groups }
    return success(value)
  }

  /**
   * One full collect cycle for one server record. Marks NOTHING as reported:
   * the scheduler pushes the alert first and then calls `confirmDelivered` to
   * durably record the pushed UPIDs/hashes, so a failed push is retried on the
   * next cycle (at-least-once delivery).
   */
  private async collectOne(record: ServerRecord): Promise<PveCollectValue> {
    const probe = await this.probeTasks(record)
    // Even when the task index fails, still surface system logs (independent
    // source) so one failure doesn't blind us to the other.
    if (!probe.ok) {
      const sys = record.systemLogEnabled ? await this.probeSystemLogs(record) : null
      const systemLogs = sys?.ok ? sys.entries : []
      const systemHashes = sys?.ok ? sys.entryHashes : []
      const systemReported = systemLogs.length
      return { reported: 0, skipped: 0, error: probe.error, systemLogs, systemHashes, systemReported }
    }

    const reported = probe.fresh.length
    const skipped = probe.entries.length - reported

    // System logs: an independent source, deduped by hash.
    let systemLogs: PveSystemLogEntry[] = []
    let systemHashes: string[] = []
    let systemReported = 0
    if (record.systemLogEnabled) {
      const sys = await this.probeSystemLogs(record)
      if (sys.ok) {
        systemLogs = sys.entries
        systemHashes = sys.entryHashes
        systemReported = sys.entries.length
      } else {
        this.ctx.logger.warn(`[pve] system log probe failed for ${record.name}: ${sys.error}`)
      }
    }

    const fresh = probe.fresh.map(task => ({
      upid: task.upid,
      type: task.type,
      target: task.target,
      user: task.user,
      status: task.status,
      ...(task.log !== undefined ? { log: task.log } : {}),
    }))
    return {
      reported,
      skipped,
      error: '',
      fresh,
      systemLogs,
      systemHashes,
      systemReported,
    }
  }

  /**
   * Mark one delivered batch as reported: the scheduler calls this AFTER a
   * successful DingTalk push, so only messages that actually reached a channel
   * are deduped away. Failed pushes leave the entries unreported and they are
   * collected again on the next cycle (at-least-once).
   */
  @Remote('confirmDelivered')
  async confirmDelivered(request: PveConfirmRequest): Promise<PveConfirmResult> {
    const table = this.requireTable()
    if (table.get(request.id) === undefined) {
      return rejected({ code: 'server-not-found', message: `server '${request.id}' not found` })
    }
    const upids = request.upids ?? []
    const hashes = request.syslogHashes ?? []
    let markedUpids = 0
    let markedHashes = 0
    if (upids.length > 0) {
      const stateTable = this.requireStateTable()
      const state = stateTable.get(request.id) ?? { processedUpids: [], lastIndexLines: 0 }
      const merged = [...state.processedUpids]
      for (const upid of upids) {
        if (!merged.includes(upid)) {
          merged.push(upid)
          markedUpids++
        }
      }
      await stateTable.put(request.id, { processedUpids: trimProcessed(merged, MAX_TRACKED_UPIDS), lastIndexLines: state.lastIndexLines })
    }
    if (hashes.length > 0) {
      const syslogStateTable = this.requireSyslogStateTable()
      const state = syslogStateTable.get(request.id) ?? { processedHashes: [] }
      const merged = [...state.processedHashes]
      for (const hash of hashes) {
        if (!merged.includes(hash)) {
          merged.push(hash)
          markedHashes++
        }
      }
      await syslogStateTable.put(request.id, { processedHashes: trimProcessed(merged, MAX_TRACKED_SYSLOG_HASHES) })
    }
    const value: PveConfirmValue = { markedUpids, markedHashes }
    return success(value)
  }

  /**
   * Query the PVE API for recent tasks, parse, and diff against
   * already-reported UPIDs. Never writes state and never sends; the client
   * is closed here regardless of outcome. Shared by `collectNow` (which then
   * marks+sends) and `collectTest` (which reports back instead).
   */
  private async probeTasks(record: ServerRecord): Promise<{
    ok: boolean
    error: string
    lines: number
    entries: PveTaskEntry[]
    fresh: PveTaskEntry[]
    nextProcessed: string[]
  }> {
    const stateTable = this.requireStateTable()
    const state = stateTable.get(record.id) ?? { processedUpids: [], lastIndexLines: 0 }

    let client: PveApiClient | null = null
    try {
      client = this.api({
        apiUrl: record.apiUrl,
        tokenId: record.apiTokenId,
        tokenSecret: decryptSecret(record.apiTokenSecret),
        node: record.node,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`[pve] api client failed for ${record.name}: ${message}`)
      return { ok: false, error: message.slice(0, 300), lines: 0, entries: [], fresh: [], nextProcessed: state.processedUpids }
    }

    try {
      const res = await client.listTasks(TASKS_LIMIT)
      if (!res.ok) {
        return { ok: false, error: res.error.slice(0, 300), lines: 0, entries: [], fresh: [], nextProcessed: state.processedUpids }
      }
      const entries = parseApiTasks(res.data)
      const { fresh: rawFresh, nextProcessed } = diffNewFailedTasks(entries, state.processedUpids)
      // Fetch each failed task's raw log so AI analysis and detail views show the real error.
      const fresh = await Promise.all(rawFresh.map(async (entry, i) => {
        if (i >= LOG_FETCH_LIMIT) return entry
        const logRes = await client!.getTaskLog(entry.upid, TASK_LOG_LIMIT)
        const raw = logRes.ok && Array.isArray(logRes.data)
          ? logRes.data
            .map(line => {
              if (typeof line !== 'object' || line === null) return ''
              const l = (line as Record<string, unknown>).l
              return typeof l === 'string' ? l : String(l ?? '')
            })
            .filter(l => l.length > 0)
            .join('\n')
          : undefined
        const log = raw !== undefined && raw.length > RAW_LOG_MAX
          ? `${raw.slice(0, RAW_LOG_MAX)}\n…(日志已截断)`
          : raw
        return { ...entry, ...(log !== undefined ? { log } : {}) }
      }))
      return { ok: true, error: '', lines: entries.length, entries, fresh, nextProcessed }
    } finally {
      client.close()
    }
  }

  /**
   * Collect node system logs via the PVE syslog API (warning and above) and
   * dedup by hash. Opens its own API client (system logs and tasks are
   * independent sources). Returns new entries after the persisted hash set,
   * plus the next hash set to persist. No-op (empty) when disabled.
   */
  private async probeSystemLogs(record: ServerRecord): Promise<{
    ok: boolean
    error: string
    entries: PveSystemLogEntry[]
    /** Dedup hashes of `entries`, same order (for the delivery-confirm step). */
    entryHashes: string[]
    nextHashes: string[]
  }> {
    if (!record.systemLogEnabled) {
      return { ok: true, error: '', entries: [], entryHashes: [], nextHashes: [] }
    }
    const stateTable = this.requireSyslogStateTable()
    const state = stateTable.get(record.id) ?? { processedHashes: [] }

    let client: PveApiClient | null = null
    try {
      client = this.api({
        apiUrl: record.apiUrl,
        tokenId: record.apiTokenId,
        tokenSecret: decryptSecret(record.apiTokenSecret),
        node: record.node,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`[pve] api client failed for ${record.name}: ${message}`)
      return { ok: false, error: message.slice(0, 300), entries: [], entryHashes: [], nextHashes: state.processedHashes }
    }

    try {
      // The syslog API reads the log from the START and returns `start`-offset
      // lines, so to get the recent tail we first probe for `total`, then ask
      // for the last `SYSLOG_LIMIT` lines via `start = total - N`.
      const probeRes = await client.getSyslog(1)
      if (!probeRes.ok) {
        return { ok: false, error: probeRes.error.slice(0, 300), entries: [], entryHashes: [], nextHashes: state.processedHashes }
      }
      const total = probeRes.total ?? 0
      const start = Math.max(1, total - SYSLOG_LIMIT + 1)
      const res = await client.getSyslog(SYSLOG_LIMIT, start)
      if (!res.ok) {
        return { ok: false, error: res.error.slice(0, 300), entries: [], entryHashes: [], nextHashes: state.processedHashes }
      }
      const parsed = parseSyslogEntries(res.data)
      const seen = new Set(state.processedHashes)
      const entries: PveSystemLogEntry[] = []
      const entryHashes: string[] = []
      const nextHashes: string[] = [...state.processedHashes]
      for (const e of parsed) {
        const hash = syslogHash(e.ts, e.unit, e.message)
        if (seen.has(hash)) continue
        seen.add(hash)
        nextHashes.push(hash)
        entries.push(e)
        entryHashes.push(hash)
      }
      const trimmed = trimProcessed(nextHashes, MAX_TRACKED_SYSLOG_HASHES)
      return { ok: true, error: '', entries, entryHashes, nextHashes: trimmed }
    } finally {
      client.close()
    }
  }

  /**
   * Probe one server without sending anything: query the PVE API for recent
   * tasks, diff new failed tasks, and report what WOULD be alerted.
   * Useful to validate credentials and see the backlog before trusting a
   * real collect cycle.
   */
  @Remote('collectTest')
  async collectTest(request: PveCollectTestRequest): Promise<PveCollectTestResult> {
    const table = this.requireTable()
    const record = table.get(request.id)
    if (record === undefined) {
      return rejected({ code: 'server-not-found', message: `server '${request.id}' not found` })
    }
    const probe = await this.probeTasks(record)
    const fresh: PveCollectTestTask[] = probe.fresh.map(task => ({
      upid: task.upid,
      type: task.type,
      target: task.target,
      user: task.user,
      status: task.status,
      ...(task.log !== undefined ? { log: task.log } : {}),
    }))
    // Dry-run the system-log probe too (no state write) when enabled.
    let systemLogs: PveSystemLogEntry[] = []
    if (record.systemLogEnabled) {
      const sys = await this.probeSystemLogs(record)
      if (sys.ok) systemLogs = sys.entries
    }
    const value: PveCollectTestValue = {
      ok: probe.ok,
      error: probe.error,
      lines: probe.lines,
      entries: probe.entries.length,
      fresh,
      wouldReport: probe.ok ? fresh.length : 0,
      systemLogs,
      systemReported: systemLogs.length,
      pushEnabled: true,
    }
    return success(value)
  }

  private requireTable(): KvTable<string, ServerRecord> {
    if (this.table === null) throw new Error('PveService not initialized')
    return this.table
  }

  private requireStateTable(): KvTable<string, TaskStateRecord> {
    if (this.stateTable === null) throw new Error('PveService not initialized')
    return this.stateTable
  }

  private requireSyslogStateTable(): KvTable<string, import('./spec.ts').SyslogStateRecord> {
    if (this.syslogStateTable === null) throw new Error('PveService not initialized')
    return this.syslogStateTable
  }
}

/** Map a stored record to the wire-safe server shape. */
function toServer(record: ServerRecord): PveServer {
  return {
    id: record.id,
    name: record.name,
    apiUrl: record.apiUrl,
    apiTokenId: record.apiTokenId,
    // Only the masked form ever crosses the Remote boundary.
    apiTokenSecret: maskSecret(record.apiTokenSecret),
    node: record.node,
    remark: record.remark,
    enabled: record.enabled,
    systemLogEnabled: record.systemLogEnabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export default PveService
