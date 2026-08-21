/**
 * PVE collector Host service: manages monitored servers (SSH credentials
 * encrypted at rest), runs one collection on demand (`collectNow`), and
 * delivers new failed-task alerts through the message-channel (DingTalk)
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
import { pveDomainSpec, MAX_TRACKED_UPIDS } from './spec.ts'
import { decryptSecret, encryptSecret, maskSecret } from './cipher.ts'
import { realSshConnector, type SshConnector } from './ssh.ts'
import { parseTaskIndex, diffNewFailedTasks, indexRotated, countLines, trimProcessed, type PveTaskEntry } from './tasks.ts'
import { analyzeAlert } from './ai.ts'
import type {
  PveCollectRequest,
  PveCollectResult,
  PveCollectTestRequest,
  PveCollectTestResult,
  PveCollectTestTask,
  PveCollectTestValue,
  PveCollectValue,
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
  PveSetEnabledRequest,
  PveSetEnabledResult,
  PveSetEnabledValue,
  PveSetPushEnabledRequest,
  PveSetPushEnabledResult,
  PveSetPushEnabledValue,
} from './types.ts'

/** Paths read from every monitored PVE node. */
const TASKS_INDEX = '/var/log/pve/tasks/index'
const TASKS_INDEX_1 = '/var/log/pve/tasks/index.1'

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
  static inject = ['storageDomain']

  private table: KvTable<string, ServerRecord> | null = null
  private stateTable: KvTable<string, TaskStateRecord> | null = null
  /** channelId → in-flight collect flag (overlapping runs are skipped). */
  private readonly collecting = new Set<string>()
  /** Injectable for tests; production uses the ssh2 connector. */
  private readonly ssh: SshConnector
  /** Injectable for tests; production sends through the dingtalk Remote. */
  private readonly sender: (channelId: string, text: string) => Promise<boolean>

  constructor(ctx: import('@deepseek-ai/cordis').Context, options?: {
    ssh?: SshConnector
    sender?: (channelId: string, text: string) => Promise<boolean>
  }) {
    super(ctx, 'pve')
    this.ssh = options?.ssh ?? realSshConnector
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
    this.ctx.logger.info(`[pve] saveServer id=${input.id} name=${input.name} host=${input.host}`)
    if (!/^[\w-]+$/.test(input.id)) {
      return rejected({ code: 'invalid-input', message: 'server id must be alphanumeric, dash, or underscore' })
    }
    if (input.name.trim().length === 0 || input.host.trim().length === 0 || input.username.trim().length === 0) {
      return rejected({ code: 'invalid-input', message: 'server name, host, and username are required' })
    }
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      return rejected({ code: 'invalid-input', message: 'port must be an integer between 1 and 65535' })
    }

    const table = this.requireTable()
    const now = new Date().toISOString()
    const existing = table.get(input.id)
    // Blank password on edit = keep the stored (encrypted) one unchanged.
    const storedPassword = input.password !== undefined && input.password.trim() !== ''
      ? encryptSecret(input.password.trim())
      : existing?.password ?? ''
    // Blank remark on edit = keep the stored value unchanged.
    const storedRemark = (input.remark !== undefined && input.remark.trim() !== '')
      ? input.remark.trim()
      : existing?.remark ?? ''

    const record: ServerRecord = {
      id: input.id,
      name: input.name.trim(),
      host: input.host.trim(),
      port: input.port,
      username: input.username.trim(),
      password: storedPassword,
      remark: storedRemark,
      enabled: input.enabled ?? existing?.enabled ?? true,
      pushEnabled: input.pushEnabled ?? existing?.pushEnabled ?? true,
      channelIds: [...(input.channelIds ?? existing?.channelIds ?? [])],
      aiEnabled: input.aiEnabled ?? existing?.aiEnabled ?? false,
      aiPrompt: input.aiPrompt ?? existing?.aiPrompt ?? '',
      aiModel: input.aiModel ?? existing?.aiModel ?? null,
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

  /** Toggle a server's push-to-DingTalk flag (atomic read-modify-write). */
  @Remote('setPushEnabled')
  async setPushEnabled(request: PveSetPushEnabledRequest): Promise<PveSetPushEnabledResult> {
    const table = this.requireTable()
    const current = table.get(request.id)
    if (current === undefined) {
      const value: PveSetPushEnabledValue = { found: false }
      return success(value)
    }
    const next = await table.update(request.id, record => ({
      ...record,
      pushEnabled: request.pushEnabled,
      updatedAt: new Date().toISOString(),
    }))
    const value: PveSetPushEnabledValue = { found: true, server: toServer(next) }
    return success(value)
  }

  /**
   * Run one collection for a server: SSH in, read the task index files,
   * diff new failed tasks, mark them reported, then deliver each alert.
   */
  @Remote('collectNow')
  async collectNow(request: PveCollectRequest): Promise<PveCollectResult> {
    const table = this.requireTable()
    const record = table.get(request.id)
    if (record === undefined) {
      return rejected({ code: 'server-not-found', message: `server '${request.id}' not found` })
    }
    if (this.collecting.has(request.id)) {
      const value: PveCollectValue = { reported: 0, skipped: 0, error: 'collection already in progress' }
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
   * One full collect cycle for one server record. `pushEnabled:false` still
   * runs the SSH probe and marks UPIDs reported, but delivers no alert —
   * re-enabling push never replays the backlog.
   */
  private async collectOne(record: ServerRecord): Promise<PveCollectValue> {
    const stateTable = this.requireStateTable()
    const probe = await this.probeTasks(record)
    if (!probe.ok) return { reported: 0, skipped: 0, error: probe.error }

    // Mark-then-send: durably record the UPIDs BEFORE any delivery, so a
    // failed send is never retried (no duplicate alerts on 5-minute cycles).
    const trimmed = trimProcessed(probe.nextProcessed, MAX_TRACKED_UPIDS)
    await stateTable.put(record.id, { processedUpids: trimmed, lastIndexLines: probe.lines })

    if (probe.fresh.length === 0) {
      return { reported: 0, skipped: 0, error: '' }
    }
    // Push switch off: mark everything, deliver nothing.
    if (record.pushEnabled === false) {
      return { reported: 0, skipped: probe.entries.length, error: '' }
    }

    let reported = 0
    for (const task of probe.fresh) {
      const alertText = [
        `【ERROR】PVE ${record.name} ${task.type} ${task.target}`.trim(),
        `服务器: ${record.host}`,
        `任务: ${task.upid}`,
        `用户: ${task.user}`,
        `状态: ${task.status}`,
      ].join('\n')
      let finalText = alertText
      if (record.aiEnabled && record.aiPrompt.trim() !== '') {
        const analysis = await analyzeAlert(this.ctx, {
          alertText,
          prompt: record.aiPrompt,
          model: record.aiModel,
        })
        finalText = `${alertText}\n\n—— AI 分析 ——\n${analysis}`
      }
      for (const channelId of record.channelIds) {
        if (await this.sender(channelId, finalText)) reported++
      }
    }
    return { reported, skipped: probe.entries.length - probe.fresh.length, error: '' }
  }

  /**
   * SSH in, read the task index files (index.1 on rotation), parse, and diff
   * against already-reported UPIDs. Never writes state and never sends; the
   * connection is closed here regardless of outcome. Shared by `collectNow`
   * (which then marks+sends) and `collectTest` (which reports back instead).
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

    let reader: Awaited<ReturnType<SshConnector>> | null = null
    try {
      reader = await this.ssh({
        host: record.host,
        port: record.port,
        username: record.username,
        password: decryptSecret(record.password),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`[pve] ssh connect failed for ${record.name}: ${message}`)
      return { ok: false, error: message.slice(0, 300), lines: 0, entries: [], fresh: [], nextProcessed: state.processedUpids }
    }

    try {
      const indexRes = await reader.readFile(TASKS_INDEX)
      if (!indexRes.ok) {
        return { ok: false, error: indexRes.error.slice(0, 300), lines: 0, entries: [], fresh: [], nextProcessed: state.processedUpids }
      }
      const lines = countLines(indexRes.content)
      const rotated = indexRotated(lines, state.lastIndexLines)
      let raw = indexRes.content
      if (rotated) {
        // The old tail (failed tasks we may not have seen yet) moved to index.1.
        const prevRes = await reader.readFile(TASKS_INDEX_1)
        if (prevRes.ok) raw = `${prevRes.content}\n${raw}`
        this.ctx.logger.info(`[pve] index rotation detected for ${record.name}, re-reading index.1`)
      }
      const entries = parseTaskIndex(raw)
      const { fresh, nextProcessed } = diffNewFailedTasks(entries, state.processedUpids)
      return { ok: true, error: '', lines, entries, fresh, nextProcessed }
    } finally {
      reader.close()
    }
  }

  /**
   * Probe one server without sending anything: SSH in, read and parse the
   * task index, diff new failed tasks, and report what WOULD be alerted.
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
    }))
    const pushEnabled = record.pushEnabled !== false
    const value: PveCollectTestValue = {
      ok: probe.ok,
      error: probe.error,
      lines: probe.lines,
      entries: probe.entries.length,
      fresh,
      wouldReport: probe.ok && pushEnabled ? fresh.length : 0,
      pushEnabled,
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
}

/** Map a stored record to the wire-safe server shape. */
function toServer(record: ServerRecord): PveServer {
  return {
    id: record.id,
    name: record.name,
    host: record.host,
    port: record.port,
    username: record.username,
    // Only the masked form ever crosses the Remote boundary.
    password: maskSecret(record.password),
    remark: record.remark,
    enabled: record.enabled,
    pushEnabled: record.pushEnabled,
    channelIds: record.channelIds,
    aiEnabled: record.aiEnabled,
    aiPrompt: record.aiPrompt,
    aiModel: record.aiModel,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export default PveService
