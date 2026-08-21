/**
 * DingTalk webhook robot Host service: multi-channel configuration persisted
 * through storage-domain, exposed as a Typert Remote so the browser client
 * half can list/save/delete channels.
 *
 * Persistence contract: `Service.init` opens the `channels` domain (loading
 * the JSON unit into memory); every `@Remote` write (`put`/`delete`) is
 * durably committed to the backend before memory mutates — no manual file
 * writes here.
 * @module @deepseek-ai/dsh-dingtalk-host
 */

import { mkdir, rm } from 'node:fs/promises'
import { Service } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ChannelRecord } from './spec.ts'
import { channelDomainSpec } from './spec.ts'
import { sendText as sendTextToDingtalk, fetchAppToken } from './send.ts'
import { decryptSecret, encryptSecret, maskSecret } from './cipher.ts'
import { connectStream, type StreamConnection } from './stream.ts'
import { runAgentTurn, dingtalkWorkspaceDir } from './agent.ts'
import type {
  DingtalkChannel,
  DingtalkDeleteRequest,
  DingtalkDeleteResult,
  DingtalkDeleteValue,
  DingtalkFailure,
  DingtalkListRequest,
  DingtalkListResult,
  DingtalkListValue,
  DingtalkSaveRequest,
  DingtalkSaveResult,
  DingtalkSendRequest,
  DingtalkSendResult,
  DingtalkSendValue,
  DingtalkSetEnabledRequest,
  DingtalkSetEnabledResult,
  DingtalkSetEnabledValue,
  DingtalkTestRequest,
  DingtalkTestResult,
  DingtalkTestValue,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dingtalk: DingtalkService
  }
}

/** Build a frozen success branch. */
function success<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/** Build a frozen rejected branch. */
function rejected<E extends DingtalkFailure>(error: E): { ok: false; error: E } {
  return { ok: false, error }
}

/** The DingTalk channel store, exposed as Remote `dingtalk`. */
export class DingtalkService extends TypertRemoteService {
  static inject = ['storageDomain']

  private table: KvTable<string, ChannelRecord> | null = null
  /** channelId → live Stream connection (enabled app-type channels). */
  private readonly streams = new Map<string, StreamConnection>()

  constructor(ctx: import('@deepseek-ai/cordis').Context) {
    super(ctx, 'dingtalk')
  }

  /** Open and own the channels domain (loads persisted channels). */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(channelDomainSpec)
    this.ctx.effect(() => () => void domain.close(), 'dingtalk.domainClose')
    this.table = domain.table('channels')
    // Start Stream connections for every already-enabled app channel.
    for (const [id, record] of this.table.entries()) {
      if (record.type === 'app' && record.enabled) {
        this.openStream(id, record)
      }
    }
  }

  /** All channels, newest first. */
  @Remote('listChannels')
  async listChannels(_request: DingtalkListRequest): Promise<DingtalkListResult> {
    const table = this.requireTable()
    const channels: DingtalkChannel[] = [...table.entries()]
      .map(([, record]) => toChannel(record))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const value: DingtalkListValue = { channels }
    return success(value)
  }

  /** Create or replace one channel; persists immediately. */
  @Remote('saveChannel')
  async saveChannel(request: DingtalkSaveRequest): Promise<DingtalkSaveResult> {
    const input = request.input
    this.ctx.logger.info(`[dingtalk] saveChannel id=${input.id} type=${input.type} name=${input.name}`)
    // Channel ids name the workspace directory and the stable session id, so
    // they must be path-safe: no slashes or `..` segments (path-traversal guard).
    if (!/^[\w-]+$/.test(input.id)) {
      return rejected({ code: 'invalid-input', message: 'channel id must be alphanumeric, dash, or underscore' })
    }
    if (input.id.trim().length === 0 || input.name.trim().length === 0) {
      return rejected({ code: 'invalid-input', message: 'channel id and name are required' })
    }

    const table = this.requireTable()
    const now = new Date().toISOString()
    const existing = table.get(input.id)
    const base = {
      id: input.id,
      name: input.name.trim(),
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    if (input.type === 'webhook') {
      try {
        new URL(input.webhookUrl)
      } catch {
        return rejected({ code: 'invalid-input', message: 'webhookUrl must be a valid URL' })
      }
      const record: ChannelRecord = {
        ...base,
        type: 'webhook',
        webhookUrl: input.webhookUrl.trim(),
        secret: input.secret ?? (existing?.type === 'webhook' ? existing.secret : '') ?? '',
      }
      await table.put(record.id, record)
      return success(toChannel(record))
    }

    // app (Stream robot): clientSecret is encrypted at rest; blank input means
    // "keep the stored secret unchanged" (edit flow), so only encrypt when a
    // new non-empty secret is provided.
    const storedSecret = existing?.type === 'app'
      ? existing.clientSecret
      : ''
    const record: ChannelRecord = {
      ...base,
      type: 'app',
      clientId: input.clientId.trim(),
      clientSecret: input.clientSecret !== undefined && input.clientSecret.trim() !== ''
        ? encryptSecret(input.clientSecret.trim())
        : storedSecret,
      agentPreset: input.agentPreset?.trim() !== '' && input.agentPreset !== undefined
        ? input.agentPreset.trim()
        : (existing?.type === 'app' && existing.agentPreset ? existing.agentPreset : 'standard'),
    }
    await table.put(record.id, record)
    // A freshly created robot channel gets its own workspace directory so the
    // agent's cwd and session files stay isolated from other channels and the
    // user's own projects. Re-edits keep the existing directory (id is
    // unchanged), so history is never lost or misaligned. The directory must
    // exist before any agent turn runs against it.
    if (existing === undefined) {
      try {
        await mkdir(dingtalkWorkspaceDir(record.id), { recursive: true })
      } catch (error) {
        return rejected({ code: 'invalid-input', message: `failed to create workspace dir: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
    // Re-sync the Stream connection: a changed secret/credentials or a fresh
    // enabled channel needs a reconnect; disabling closes it.
    if (record.enabled) {
      this.closeStream(record.id)
      this.openStream(record.id, record)
    } else {
      this.closeStream(record.id)
    }
    return success(toChannel(record))
  }

  /** Delete one channel; persists immediately. */
  @Remote('deleteChannel')
  async deleteChannel(request: DingtalkDeleteRequest): Promise<DingtalkDeleteResult> {
    if (!/^[\w-]+$/.test(request.id)) {
      return rejected({ code: 'invalid-input', message: 'channel id must be alphanumeric, dash, or underscore' })
    }
    const table = this.requireTable()
    this.closeStream(request.id)
    const deleted = await table.delete(request.id)
    // Only remove the robot's dedicated workspace when the user opted in from
    // the delete-confirmation dialog; otherwise keep it (with its session
    // history) so a mistaken delete is recoverable. The path is pinned to
    // `$DSH_HOME/workspaces/dingtalk/<id>`, so it can never escape the
    // channel's own directory.
    if (request.removeWorkspace === true) {
      await rm(dingtalkWorkspaceDir(request.id), { recursive: true, force: true })
    }
    const value: DingtalkDeleteValue = { deleted }
    return success(value)
  }

  /** Toggle a channel's enabled flag (atomic read-modify-write). */
  @Remote('setEnabled')
  async setEnabled(request: DingtalkSetEnabledRequest): Promise<DingtalkSetEnabledResult> {
    const table = this.requireTable()
    const current = table.get(request.id)
    if (current === undefined) {
      const value: DingtalkSetEnabledValue = { found: false }
      return success(value)
    }
    const next = await table.update(request.id, record => ({
      ...record,
      enabled: request.enabled,
      updatedAt: new Date().toISOString(),
    }))
    // Keep Stream connections in sync with the enabled flag.
    if (next.type === 'app') {
      if (next.enabled) this.openStream(request.id, next)
      else this.closeStream(request.id)
    }
    const value: DingtalkSetEnabledValue = { found: true, channel: toChannel(next) }
    return success(value)
  }

  /** Send a text message through one channel. */
  @Remote('sendText')
  async sendText(request: DingtalkSendRequest): Promise<DingtalkSendResult> {
    const table = this.requireTable()
    const channel = table.get(request.id)
    if (channel === undefined) {
      return rejected({ code: 'channel-not-found', message: `channel '${request.id}' not found` })
    }
    if (!channel.enabled) {
      return rejected({ code: 'invalid-input', message: `channel '${request.id}' is disabled` })
    }
    if (request.content.trim().length === 0) {
      return rejected({ code: 'invalid-input', message: 'message content is empty' })
    }
    try {
      await sendTextToDingtalk(toChannel(channel), request.content)
    } catch (error) {
      return rejected({ code: 'send-failed', message: error instanceof Error ? error.message : String(error) })
    }
    const value: DingtalkSendValue = { sent: true }
    return success(value)
  }

  /** Send a canned test message through one channel; returns the detail. */
  @Remote('testChannel')
  async testChannel(request: DingtalkTestRequest): Promise<DingtalkTestResult> {
    const table = this.requireTable()
    const record = table.get(request.id)
    if (record === undefined) {
      return rejected({ code: 'channel-not-found', message: `channel '${request.id}' not found` })
    }
    try {
      if (record.type === 'webhook') {
        const preview = `[dsh-dingtalk] 测试消息 @ ${new Date().toISOString()}`
        await sendTextToDingtalk(toChannel(record), preview)
        const value: DingtalkTestValue = { ok: true, detail: `已发送测试消息: ${preview}` }
        return success(value)
      }
      // app (Stream robot) is receive-side and cannot push messages, so the
      // test instead validates the clientId/clientSecret by exchanging them for
      // a DingTalk access_token via gettoken.
      await fetchAppToken(record.clientId, decryptSecret(record.clientSecret))
      const value: DingtalkTestValue = { ok: true, detail: '凭据有效（access_token 获取成功）' }
      return success(value)
    } catch (error) {
      const value: DingtalkTestValue = { ok: false, detail: error instanceof Error ? error.message : String(error) }
      return success(value)
    }
  }

  private requireTable(): KvTable<string, ChannelRecord> {
    if (this.table === null) throw new Error('DingtalkService not initialized')
    return this.table
  }

  /** Start (or keep) the Stream connection for an app channel. */
  private openStream(id: string, record: ChannelRecord): void {
    if (record.type !== 'app') return
    const existing = this.streams.get(id)
    if (existing !== undefined) return
    // Older records may lack agentPreset; default to the standard preset.
    const agentPreset = record.agentPreset ?? 'standard'
    const conn = connectStream(
      { id, name: record.name, type: 'app', clientId: record.clientId, clientSecret: '', agentPreset, enabled: record.enabled, createdAt: record.createdAt, updatedAt: record.updatedAt },
      decryptSecret(record.clientSecret),
      (msg) => {
        this.ctx.logger.info(`[dingtalk-stream] @${msg.senderNick}: ${msg.content} (conv=${msg.conversationId})`)
        this.handleIncomingMessage(id, agentPreset, msg)
      },
    )
    if (conn !== null) this.streams.set(id, conn)
  }

  /** Close the Stream connection for a channel id. */
  private closeStream(id: string): void {
    const conn = this.streams.get(id)
    if (conn !== undefined) {
      conn.disconnect()
      this.streams.delete(id)
    }
  }

  /** React to an incoming @-message: run a DSH agent turn and reply in-group. */
  private handleIncomingMessage(
    channelId: string,
    agentPreset: string,
    msg: { conversationId: string; content: string; senderNick: string; msgId: string; sessionWebhook: string },
  ): void {
    void (async () => {
      const reply = await runAgentTurn(this.ctx, agentPreset, channelId, msg.content)
      this.ctx.logger.info(`[dingtalk-stream] reply to ${msg.senderNick}: ${reply.slice(0, 200)}`)
      await this.replyToSession(msg.sessionWebhook, reply)
    })()
  }

  /** POST a text reply back to the group through the session webhook. */
  private async replyToSession(sessionWebhook: string, text: string): Promise<void> {
    if (sessionWebhook === '') {
      this.ctx.logger.warn('[dingtalk-stream] no sessionWebhook to reply on')
      return
    }
    try {
      const res = await fetch(sessionWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      })
      const raw = await res.text()
      if (!res.ok || !raw.includes('"errcode":0')) {
        this.ctx.logger.warn(`[dingtalk-stream] reply rejected: ${res.status} ${raw.slice(0, 200)}`)
      }
    } catch (error) {
      this.ctx.logger.warn(`[dingtalk-stream] reply failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Map a stored record to the wire-safe channel shape. */
function toChannel(record: ChannelRecord): DingtalkChannel {
  if (record.type === 'webhook') {
    return {
      id: record.id,
      name: record.name,
      type: 'webhook',
      webhookUrl: record.webhookUrl,
      secret: record.secret,
      enabled: record.enabled,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }
  return {
    id: record.id,
    name: record.name,
    type: 'app',
    clientId: record.clientId,
    // Only the masked form ever crosses the Remote boundary; the real
    // plaintext stays inside the Host for the Stream connection.
    clientSecret: maskSecret(record.clientSecret),
    agentPreset: record.agentPreset,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export default DingtalkService
