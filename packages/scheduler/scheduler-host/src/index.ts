/**
 * Scheduler Host service — cron-driven jobs with a unified execution pipeline.
 *
 * Two fixed task types:
 * - `pve`: run the PVE collector (SSH read + dedup), optionally AI-analyze the
 *   collected failures, then push the composed alert to every selected channel.
 * - `agent`: hand a prompt to a root agent (with optional skill injection),
 *   wait for the turn, then push the agent's returned text to the channels.
 *
 * A single process-local tick loop (setInterval, 15s) scans the jobs table and
 * fires any enabled job whose `nextRunAt` has passed, then recomputes the next
 * run from the cron schedule. The same operations are exposed as Remotes for
 * the client UI and wrapped as agent tools in agent-tools.ts.
 *
 * @module @deepseek-ai/dsh-scheduler-host
 */

import { Service } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { PveListRequest } from '@deepseek-ai/dsh-pve-host/types'
import type { PveService } from '@deepseek-ai/dsh-pve-host'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-skill'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { schedulerDomainSpec, MAX_RUN_LOGS, type JobRecord } from './spec.ts'
import { registerSchedulerAgentTools } from './agent-tools.ts'
import { parseCron, nextRun, CronError } from './cron.ts'
import { analyzeAlert } from '@deepseek-ai/dsh-pve-host/src/ai.ts'
import type {
  SchedulerDeleteRequest, SchedulerDeleteResult, SchedulerDeleteValue,
  SchedulerFailure,
  SchedulerGetSettingsRequest, SchedulerGetSettingsResult, SchedulerGetSettingsValue,
  SchedulerJob,
  SchedulerListChannelsRequest, SchedulerListChannelsResult, SchedulerListChannelsValue,
  SchedulerListModelsRequest, SchedulerListModelsResult, SchedulerListModelsValue,
  SchedulerListPveServersRequest, SchedulerListPveServersResult, SchedulerListPveServersValue,
  SchedulerListRequest, SchedulerListResult, SchedulerListValue,
  SchedulerListSkillsRequest, SchedulerListSkillsResult, SchedulerListSkillsValue,
  SchedulerRunNowRequest, SchedulerRunNowResult, SchedulerRunNowValue,
  SchedulerSaveRequest, SchedulerSaveResult,
  SchedulerSaveSettingsRequest, SchedulerSaveSettingsResult,
  SchedulerSetEnabledRequest, SchedulerSetEnabledResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    scheduler: SchedulerService
    /** PVE collection service (declared by the pve-host plugin). */
    pve: PveService
  }
}

function success<T>(value: T): { ok: true; value: T } { return { ok: true, value } }
function rejected<E extends SchedulerFailure>(error: E): { ok: false; error: E } { return { ok: false, error } }

/** Tick cadence of the scheduler loop. */
const TICK_MS = 15_000
/** Cap on how long one agent turn may take before the job is marked error. */
const AGENT_TIMEOUT_MS = 180_000

/**
 * Global cap on concurrent AI analyses across ALL scheduled jobs. One shared
 * semaphore keeps model API rate limits safe even when several PVE jobs fire
 * at the same time; `0` disables the cap (unlimited).
 */
const DEFAULT_AI_CONCURRENCY = 4

/**
 * Simple counting semaphore: `acquire()` waits until a slot is free, then
 * consumes it; `release()` hands the slot to the next waiter or restores it.
 * A non-positive limit means unlimited (acquire never waits). `setLimit`
 * adjusts the cap live; shrinking below the current usage makes the excess
 * wait until running analyses finish.
 */
class Semaphore {
  private available: number
  private limit: number
  private readonly waiters: Array<() => void> = []
  constructor(limit: number) {
    this.limit = limit > 0 ? limit : Infinity
    this.available = this.limit
  }
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
  }
  release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) next()
    else this.available++
  }
  setLimit(limit: number): void {
    const next = limit > 0 ? limit : Infinity
    this.available += next - this.limit
    this.limit = next
  }
}

/** DingTalk channel + sender surface, resolved lazily via reflect. */
interface DingtalkSurface {
  listChannels(_request: { readonly _?: never }): Promise<{ ok: boolean; value?: { channels?: Array<{ id: string; name: string; type: string }> } }>
  sendText(request: { readonly id: string; readonly content: string }): Promise<{ ok: boolean; value?: { sent: boolean } }>
}

/** The cron-driven job store, exposed as Remote `scheduler`. */
export class SchedulerService extends TypertRemoteService {
  static inject = ['storageDomain', 'agents', 'tools', 'skills', 'pve']

  private table: KvTable<string, JobRecord> | null = null
  /** Module-level persisted settings (global AI concurrency). */
  private globalHandle: import('@deepseek-ai/dsh-storage-domain').DomainGlobal<import('./spec.ts').SchedulerGlobalRecord> | null = null
  /** Shared across every job: caps how many AI analyses run at once. */
  private readonly aiSemaphore: Semaphore

  constructor(ctx: import('@deepseek-ai/cordis').Context) {
    super(ctx, 'scheduler')
    this.aiSemaphore = new Semaphore(DEFAULT_AI_CONCURRENCY)
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(schedulerDomainSpec)
    this.ctx.effect(() => () => void domain.close(), 'scheduler.domainClose')
    this.table = domain.table('jobs')
    this.globalHandle = domain.global as import('@deepseek-ai/dsh-storage-domain').DomainGlobal<import('./spec.ts').SchedulerGlobalRecord>
    // Apply the persisted module-level concurrency cap at startup.
    this.aiSemaphore.setLimit(this.globalHandle.get().aiConcurrency)
    // Expose the service to agents: install tools into every root agent scope.
    this.ctx.effect(() => registerSchedulerAgentTools(this.ctx), 'scheduler.agentTools')
    // Start the process-local tick loop; cleared on dispose.
    const timer = setInterval(() => { void this.tick() }, TICK_MS)
    this.ctx.effect(() => () => clearInterval(timer), 'scheduler.tick')
  }

  @Remote('listJobs')
  async listJobs(_request: SchedulerListRequest): Promise<SchedulerListResult> {
    const table = this.requireTable()
    const jobs: SchedulerJob[] = [...table.entries()]
      .map(([, r]) => toJob(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const value: SchedulerListValue = { jobs }
    return success(value)
  }

  @Remote('getSettings')
  async getSettings(_request: SchedulerGetSettingsRequest): Promise<SchedulerGetSettingsResult> {
    const value: SchedulerGetSettingsValue = { aiConcurrency: this.requireGlobal().get().aiConcurrency }
    return success(value)
  }

  @Remote('saveSettings')
  async saveSettings(request: SchedulerSaveSettingsRequest): Promise<SchedulerSaveSettingsResult> {
    const n = request.aiConcurrency
    if (!Number.isInteger(n) || n < 0 || n > 20) {
      return rejected({ code: 'invalid-input', message: 'aiConcurrency must be an integer between 0 and 20 (0 = unlimited)' })
    }
    const next = { aiConcurrency: n }
    const global = this.requireGlobal()
    await global.set(next)
    // Apply immediately to the shared semaphore (excess runs simply wait).
    this.aiSemaphore.setLimit(n)
    return success({ aiConcurrency: global.get().aiConcurrency })
  }

  @Remote('saveJob')
  async saveJob(request: SchedulerSaveRequest): Promise<SchedulerSaveResult> {
    const input = request.input
    if (!/^[\w-]+$/.test(input.id))
      return rejected({ code: 'invalid-input', message: 'id must be alphanumeric, dash, or underscore' })
    if (input.name.trim().length === 0)
      return rejected({ code: 'invalid-input', message: 'name is required' })
    if (input.type === 'pve' && input.pveServerId?.trim().length === 0)
      return rejected({ code: 'invalid-input', message: 'pveServerId is required for pve jobs' })
    if (input.type === 'agent' && input.prompt?.trim().length === 0)
      return rejected({ code: 'invalid-input', message: 'prompt is required for agent jobs' })
    try {
      parseCron(input.cron)
    } catch (error) {
      const message = error instanceof CronError ? error.message : 'invalid cron expression'
      return rejected({ code: 'invalid-cron', message })
    }
    const table = this.requireTable()
    const now = new Date().toISOString()
    const existing = table.get(input.id)
    const enabled = input.enabled ?? existing?.enabled ?? true
    // Recompute next run from the new cron so the card shows the correct time immediately.
    const next = enabled ? this.computeNext(input.cron, Date.now()) : null
    const record: JobRecord = {
      id: input.id,
      name: input.name.trim(),
      type: input.type,
      cron: input.cron.trim(),
      enabled,
      pveServerId: input.type === 'pve' ? (input.pveServerId ?? existing?.pveServerId ?? '') : '',
      aiEnabled: input.aiEnabled ?? existing?.aiEnabled ?? false,
      model: input.model !== undefined ? input.model : (existing?.model ?? null),
      prompt: input.prompt ?? existing?.prompt ?? '',
      skillName: input.skillName ?? existing?.skillName ?? '',
      channelIds: input.channelIds !== undefined ? [...input.channelIds] : (existing?.channelIds ?? []),
      lastRunAt: existing?.lastRunAt ?? null,
      nextRunAt: next === null ? null : next.toISOString(),
      lastStatus: existing?.lastStatus ?? null,
      lastMessage: existing?.lastMessage ?? null,
      runLogs: existing?.runLogs ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await table.put(record.id, record)
    return success(toJob(record))
  }

  @Remote('deleteJob')
  async deleteJob(request: SchedulerDeleteRequest): Promise<SchedulerDeleteResult> {
    const table = this.requireTable()
    const deleted = await table.delete(request.id)
    const value: SchedulerDeleteValue = { deleted }
    return success(value)
  }

  @Remote('setEnabled')
  async setEnabled(request: SchedulerSetEnabledRequest): Promise<SchedulerSetEnabledResult> {
    const table = this.requireTable()
    const existing = table.get(request.id)
    if (existing === undefined)
      return rejected({ code: 'not-found', message: `job '${request.id}' not found` })
    const record: JobRecord = { ...existing, enabled: request.enabled, updatedAt: new Date().toISOString() }
    await table.put(record.id, record)
    return success({ job: toJob(record) })
  }

  @Remote('runNow')
  async runNow(request: SchedulerRunNowRequest): Promise<SchedulerRunNowResult> {
    const table = this.requireTable()
    const job = table.get(request.id)
    if (job === undefined)
      return rejected({ code: 'not-found', message: `job '${request.id}' not found` })
    const value: SchedulerRunNowValue = { id: job.id, started: true }
    void this.fire(job)
    return success(value)
  }

  @Remote('listPveServers')
  async listPveServers(_request: SchedulerListPveServersRequest): Promise<SchedulerListPveServersResult> {
    try {
      const result = await this.ctx.pve.listServers({} as PveListRequest)
      if (!result.ok) {
        return rejected({ code: 'pve-unavailable', message: 'pve service returned an error' })
      }
      const value: SchedulerListPveServersValue = {
        servers: result.value.servers.map(server => ({ id: server.id, name: server.name })),
      }
      return success(value)
    } catch {
      return rejected({ code: 'pve-unavailable', message: 'pve service unavailable' })
    }
  }

  @Remote('listChannels')
  async listChannels(_request: SchedulerListChannelsRequest): Promise<SchedulerListChannelsResult> {
    const dingtalk = this.dingtalk()
    if (dingtalk === undefined) {
      return rejected({ code: 'channel-unavailable', message: 'dingtalk service unavailable' })
    }
    try {
      const result = await dingtalk.listChannels({})
      if (!result.ok) {
        return rejected({ code: 'channel-unavailable', message: 'dingtalk returned an error' })
      }
      const value: SchedulerListChannelsValue = {
        channels: (result.value?.channels ?? []).map(channel => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
        })),
      }
      return success(value)
    } catch {
      return rejected({ code: 'channel-unavailable', message: 'dingtalk service unavailable' })
    }
  }

  @Remote('listModels')
  async listModels(_request: SchedulerListModelsRequest): Promise<SchedulerListModelsResult> {
    try {
      const result = await this.ctx.pve.listModels({})
      if (!result.ok) {
        return rejected({ code: 'model-unavailable', message: 'model catalog unavailable' })
      }
      const value: SchedulerListModelsValue = {
        groups: (result.value.groups ?? []).map(group => ({
          name: group.provider,
          models: (group.models ?? []).map(model => ({
            provider: group.provider,
            model,
          })),
        })),
      }
      return success(value)
    } catch {
      return rejected({ code: 'model-unavailable', message: 'model catalog unavailable' })
    }
  }

  @Remote('listSkills')
  async listSkills(_request: SchedulerListSkillsRequest): Promise<SchedulerListSkillsResult> {
    try {
      const agent = this.rootAgent()
      const skills = await this.ctx.skills.list({
        cwd: agent?.session.header.cwd ?? process.cwd(),
        scope: agent,
      })
      const value: SchedulerListSkillsValue = {
        skills: skills.map(skill => ({ name: skill.name, description: skill.description })),
      }
      return success(value)
    } catch {
      return rejected({ code: 'invalid-input', message: 'skill catalog unavailable' })
    }
  }

  /** Scan enabled jobs and fire those whose next run is due; recompute next runs. */
  private async tick(): Promise<void> {
    const table = this.requireTable()
    const now = Date.now()
    for (const [, job] of table.entries()) {
      if (!job.enabled) continue
      if (job.nextRunAt === null) {
        // First activation or a previously failed computation: derive the next run now.
        const next = this.computeNext(job.cron, now)
        if (next !== null) {
          await table.put(job.id, { ...job, nextRunAt: next.toISOString(), updatedAt: new Date().toISOString() })
        }
        continue
      }
      if (Date.parse(job.nextRunAt) <= now) {
        void this.fire(job)
      }
    }
  }

  /**
   * Fire one job: move its next run forward immediately (so the tick loop never
   * double-fires), then run the type-specific pipeline and record the outcome.
   */
  private async fire(job: JobRecord): Promise<void> {
    const table = this.requireTable()
    const next = this.computeNext(job.cron, Date.now())
    const stamp = new Date().toISOString()
    const queued: JobRecord = {
      ...job,
      nextRunAt: next === null ? null : next.toISOString(),
      updatedAt: stamp,
    }
    await table.put(job.id, queued)
    // Record one bounded run-log entry (newest first), appended by the outcome below.
    const withLog = (base: JobRecord, status: 'ok' | 'error', message: string): JobRecord => ({
      ...base,
      runLogs: [{ at: new Date().toISOString(), status, message }, ...base.runLogs].slice(0, MAX_RUN_LOGS),
    })
    try {
      const outcome = job.type === 'pve' ? await this.runPveJob(job) : await this.runAgentJob(job)
      const done: JobRecord = {
        ...withLog(queued, outcome.ok ? 'ok' : 'error', outcome.message),
        lastRunAt: new Date().toISOString(),
        lastStatus: outcome.ok ? 'ok' : 'error',
        lastMessage: outcome.message,
        updatedAt: new Date().toISOString(),
      }
      await table.put(job.id, done)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const done: JobRecord = {
        ...withLog(queued, 'error', message),
        lastRunAt: new Date().toISOString(),
        lastStatus: 'error',
        lastMessage: message,
        updatedAt: new Date().toISOString(),
      }
      await table.put(job.id, done)
    }
  }

  /** PVE pipeline: collect (tasks + system logs) -> optional AI -> push composed alert -> confirm delivered. */
  private async runPveJob(job: JobRecord): Promise<{ ok: boolean; message: string }> {
    const result = await this.ctx.pve.collectNow({ id: job.pveServerId })
    if (!result.ok) {
      return { ok: false, message: `collect failed: ${result.error.message}` }
    }
    const { reported, skipped, error, fresh, systemLogs, systemHashes, systemReported } = result.value
    if (error !== '') {
      return { ok: false, message: `collect error: ${error}` }
    }
    if (reported === 0 && systemReported === 0) {
      return { ok: true, message: `no new failures (${skipped} skipped)` }
    }

    const sections: string[] = []
    const aiOn = job.aiEnabled && job.prompt.trim() !== ''
    const AI_ANALYZE_CAP = 10 // 多条时最多逐条独立分析的条数，超出只列明细以控成本

    // --- PVE task failures (per-task AI analysis, bounded concurrency) ---
    if (reported > 0) {
      const tasks = (fresh ?? []).slice(0, 50)
      const blockFor = (task: (typeof tasks)[number], i: number): string => {
        const head = `──── 明细 ${i + 1} ────\n[${task.status}]\nUPID：${task.upid}\n类型：${task.type} · 目标：${task.target} · 用户：${task.user}`
        const log = task.log ? `\n原始日志：\n${task.log.trim()}` : ''
        return head + log
      }
      const blocks = tasks.map((task, i) => blockFor(task, i))
      let taskSection = `【PVE 任务失败】${reported} 个新失败任务\n\n${blocks.join('\n\n')}`
      if (aiOn) {
        const limit = Math.min(tasks.length, AI_ANALYZE_CAP)
        const analyzeBlocks: string[] = new Array(limit)
        // Submit every analysis as its own worker; the GLOBAL semaphore caps
        // how many actually run in flight across all jobs.
        const concurrency = limit
        let cursor = 0
        const worker = async (): Promise<void> => {
          while (true) {
            const i = cursor++
            if (i >= limit) return
            // Global semaphore: bounds total in-flight analyses across ALL jobs.
            await this.aiSemaphore.acquire()
            try {
              analyzeBlocks[i] = await analyzeAlert(this.ctx, {
                alertText:
                  tasks.length === 1
                    ? `PVE ${job.name}: 1 个新失败任务。请基于以下原始日志分析根因、影响与处置建议。\n\n${blocks[i]}`
                    : `PVE ${job.name}: 多个失败任务之一，请单独分析这一条（根因/影响/处置）。\n\n${blocks[i]}`,
                prompt: job.prompt,
                model: job.model,
              })
            } finally {
              this.aiSemaphore.release()
            }
          }
        }
        await Promise.all(Array.from({ length: concurrency }, worker))
        let aiSection = analyzeBlocks.join('\n\n')
        if (tasks.length > AI_ANALYZE_CAP) {
          aiSection += `\n\n（其余 ${tasks.length - AI_ANALYZE_CAP} 条仅列出明细，未逐一分析以控制成本）`
        }
        taskSection = `【PVE 任务失败】${reported} 个新失败任务\n\n${aiSection}`
      }
      sections.push(taskSection)
    }

    // --- Node system logs (per-entry AI analysis, bounded concurrency) ---
    if (systemReported > 0) {
      const sys = (systemLogs ?? []).slice(0, 50)
      const blockFor = (e: (typeof sys)[number], i: number): string =>
        `──── 系统日志 ${i + 1} ────\n\n[${e.priority}] ${e.ts} · ${e.unit}\n\n${e.message}`
      let sysSection: string
      if (aiOn) {
        const limit = Math.min(sys.length, AI_ANALYZE_CAP)
        const analyzeBlocks: string[] = new Array(limit)
        // Same global-semaphore capping as the task-failure analyses.
        const concurrency = limit
        let cursor = 0
        const worker = async (): Promise<void> => {
          while (true) {
            const i = cursor++
            if (i >= limit) return
            await this.aiSemaphore.acquire()
            try {
              analyzeBlocks[i] = await analyzeAlert(this.ctx, {
                alertText: `PVE ${job.name}: 一条节点系统日志（err/warning）。请分析根因、影响与处置建议。\n\n${blockFor(sys[i]!, i)}`,
                prompt: job.prompt,
                model: job.model,
              })
            } finally {
              this.aiSemaphore.release()
            }
          }
        }
        await Promise.all(Array.from({ length: concurrency }, worker))
        sysSection = `【节点系统日志】${systemReported} 条\n\n${sys
          .map((e, i) => (i < limit ? `${blockFor(e, i)}\n\nai分析\n${analyzeBlocks[i]}` : blockFor(e, i)))
          .join('\n\n')}`
        if (sys.length > AI_ANALYZE_CAP) {
          sysSection += `\n\n（其余 ${sys.length - AI_ANALYZE_CAP} 条仅列出明细，未逐一分析以控制成本）`
        }
      } else {
        sysSection = `【节点系统日志】${systemReported} 条\n\n${sys.map(blockFor).join('\n\n')}`
      }
      sections.push(sysSection)
    }

    const pushText = sections.join('\n\n')
    const pushed = await this.pushToChannels(job.channelIds, pushText)
    if (!pushed) {
      // Nothing was delivered: leave everything unreported so the next cycle
      // recollects and retries (at-least-once).
      return { ok: false, message: 'push failed: no channel delivered the alert; will retry next cycle' }
    }
    // Delivered: mark exactly what was in this message as reported.
    const pushedUpids = reported > 0 ? (fresh ?? []).slice(0, 50).map(task => task.upid) : []
    const sys = (systemLogs ?? []).slice(0, 50)
    const pushedHashes = sys.length > 0 ? (systemHashes ?? []).slice(0, sys.length) : []
    try {
      await this.ctx.pve.confirmDelivered({ id: job.pveServerId, upids: pushedUpids, syslogHashes: pushedHashes })
    } catch (confirmError) {
      // A failed confirm only risks a duplicate next cycle (at-least-once).
      this.ctx.logger.warn(`[scheduler] confirmDelivered failed for ${job.name}: ${confirmError instanceof Error ? confirmError.message : String(confirmError)}`)
    }
    return { ok: true, message: `reported ${reported} tasks, ${systemReported} system logs${aiOn ? ', ai analysis included' : ''}` }
  }

  /** Agent pipeline: inject the chosen skill body, follow up the prompt, wait, push the reply. */
  private async runAgentJob(job: JobRecord): Promise<{ ok: boolean; message: string }> {
    const agent = this.rootAgent()
    if (agent === undefined) {
      return { ok: false, message: 'no root agent available to run the prompt' }
    }
    const skillBlock = await this.loadSkillBlock(job.skillName)
    const text = `${job.prompt.trim()}${skillBlock}`
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'scheduler' },
    })
    const before = agent.session.events.length
    agent.followup(message)
    // Wait for the agent turn, bounded by a timeout.
    await Promise.race([agent.whenIdle(), new Promise(resolve => setTimeout(resolve, AGENT_TIMEOUT_MS))])
    const reply = this.lastAssistantText(agent, before)
    if (reply === '') {
      return { ok: false, message: 'agent returned no text output' }
    }
    await this.pushToChannels(job.channelIds, reply)
    return { ok: true, message: 'agent run completed and pushed' }
  }

  /**
   * Load the chosen skill body and render a bounded instruction block.
   * Full body per the A strategy, capped so a huge skill cannot flood the
   * prompt; the block names the skill and quotes its content verbatim.
   */
  private async loadSkillBlock(skillName: string): Promise<string> {
    if (skillName.trim() === '') return ''
    try {
      const agent = this.rootAgent()
      const skill = await this.ctx.skills.get(skillName, {
        cwd: agent?.session.header.cwd ?? process.cwd(),
        scope: agent,
      })
      if (skill === undefined) {
        return `\n\n（提示：任务指定了 skill「${skillName}」但未找到，已忽略）`
      }
      const body = skill.content.trim()
      const capped = body.length > 8000 ? `${body.slice(0, 8000)}\n…（内容过长已截断）` : body
      return `\n\n【Skill: ${skill.name}】\n${capped}`
    } catch {
      return `\n\n（提示：任务指定了 skill「${skillName}」但加载失败，已忽略）`
    }
  }

  /**
   * Push one text payload to every selected channel.
   * @returns true only when EVERY channel delivered (sent === true); a missing
   * DingTalk service or a failed send returns false so the caller can retry.
   */
  private async pushToChannels(channelIds: readonly string[], content: string): Promise<boolean> {
    const dingtalk = this.dingtalk()
    if (dingtalk === undefined) {
      this.ctx.logger.warn('[scheduler] push skipped: dingtalk service unavailable')
      return false
    }
    if (channelIds.length === 0) {
      this.ctx.logger.warn('[scheduler] push skipped: no channels configured')
      return false
    }
    let allOk = true
    for (const id of channelIds) {
      try {
        const result = await dingtalk.sendText({ id, content })
        if (!result.ok || result.value?.sent !== true) {
          allOk = false
          this.ctx.logger.warn(`[scheduler] push to channel ${id} failed`)
        }
      } catch (error) {
        allOk = false
        this.ctx.logger.warn(`[scheduler] push to channel ${id} threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return allOk
  }

  /** First available root agent, or undefined. */
  private rootAgent(): Agent | undefined {
    return this.ctx.agents.roots()[0]
  }

  /** Extract the newest assistant text appended after `before` event count. */
  private lastAssistantText(agent: Agent, before: number): string {
    const parts: string[] = []
    for (const event of agent.session.events.slice(before)) {
      if (event.type !== 'assistant/message') continue
      const message = (event.data as { message?: { content?: unknown } }).message
      const content = message?.content
      if (typeof content === 'string') {
        parts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; text?: string }
          if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
        }
      }
    }
    return parts.join('\n').trim()
  }

  /** Lazily resolved DingTalk surface, or undefined when the plugin is absent. */
  private dingtalk(): DingtalkSurface | undefined {
    return this.ctx.reflect.get('dingtalk', false) as DingtalkSurface | undefined
  }

  /** Next fire time for a cron expression, or null if the expression is invalid. */
  private computeNext(cron: string, from: number): Date | null {
    try {
      return nextRun(parseCron(cron), new Date(from))
    } catch {
      return null
    }
  }

  private requireTable(): KvTable<string, JobRecord> {
    if (this.table === null) throw new Error('SchedulerService not initialized')
    return this.table
  }

  private requireGlobal(): import('@deepseek-ai/dsh-storage-domain').DomainGlobal<import('./spec.ts').SchedulerGlobalRecord> {
    if (this.globalHandle === null) throw new Error('SchedulerService not initialized')
    return this.globalHandle
  }
}

function toJob(r: JobRecord): SchedulerJob {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    cron: r.cron,
    enabled: r.enabled,
    pveServerId: r.pveServerId,
    aiEnabled: r.aiEnabled,
    model: r.model,
    prompt: r.prompt,
    skillName: r.skillName,
    channelIds: [...r.channelIds],
    lastRunAt: r.lastRunAt,
    nextRunAt: r.nextRunAt,
    lastStatus: r.lastStatus,
    lastMessage: r.lastMessage,
    runLogs: r.runLogs,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

export default SchedulerService
