/**
 * Public request, value, and failure vocabulary for the DingTalk channel
 * Remote. Types only — generated Remote clients consume this without
 * importing Host runtime code.
 * @module @deepseek-ai/dsh-dingtalk-host/types
 */

/** Which kind of DingTalk endpoint this channel posts to. */
export type DingtalkChannelType = 'webhook' | 'app'

/**
 * A group custom-robot webhook channel: POST directly to the robot's
 * webhook URL, optionally HMAC-signed when a secret is set.
 */
export interface DingtalkWebhookChannel {
  readonly id: string
  readonly name: string
  readonly type: 'webhook'
  readonly webhookUrl: string
  readonly secret: string
  readonly enabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * A DingTalk robot channel in Stream mode: the service connects to DingTalk's
 * Stream gateway with clientId + clientSecret so the bot can be @-mentioned in
 * a group chat and reply. clientSecret is stored encrypted. `agentPreset`
 * names the DSH agent preset (e.g. "standard") whose skills the bot executes.
 */
export interface DingtalkAppChannel {
  readonly id: string
  readonly name: string
  readonly type: 'app'
  readonly clientId: string
  readonly clientSecret: string
  readonly agentPreset: string
  readonly enabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/** One DingTalk channel configuration, discriminated by `type`. */
export type DingtalkChannel = DingtalkWebhookChannel | DingtalkAppChannel

/** Input accepted when creating or updating one channel. */
export type DingtalkChannelInput =
  | ({
    readonly id: string
    readonly name: string
    readonly type: 'webhook'
    readonly webhookUrl: string
    readonly secret?: string
    readonly enabled?: boolean
  })
  | ({
    readonly id: string
    readonly name: string
    readonly type: 'app'
    readonly clientId: string
    /** Blank when editing = keep the stored secret unchanged. */
    readonly clientSecret?: string
    /** DSH agent preset id; defaults to "standard" when blank. */
    readonly agentPreset?: string
    readonly enabled?: boolean
  })

/** Read all channels. */
export interface DingtalkListRequest {
  readonly _?: never
}

/** Current channel list, in display order. */
export interface DingtalkListValue {
  readonly channels: readonly DingtalkChannel[]
}

/** Create or replace one channel. */
export interface DingtalkSaveRequest {
  readonly input: DingtalkChannelInput
}

/** The stored channel after a save. */
export type DingtalkSaveValue = DingtalkChannel

/** Delete one channel by id. */
export interface DingtalkDeleteRequest {
  readonly id: string
  /** When true, also remove the robot's dedicated workspace directory. */
  readonly removeWorkspace?: boolean
}

/** Whether a delete removed a channel. */
export interface DingtalkDeleteValue {
  readonly deleted: boolean
}

/** Toggle a channel's enabled flag. */
export interface DingtalkSetEnabledRequest {
  readonly id: string
  readonly enabled: boolean
}

/**
 * The stored channel after toggling. `found: false` encodes a missing
 * channel — Typert Remote boundaries only allow JSON types, so `undefined`
 * is not expressible here.
 */
export type DingtalkSetEnabledValue =
  | { readonly found: true; readonly channel: DingtalkChannel }
  | { readonly found: false }

/** A concrete business failure. */
export type DingtalkFailure =
  | { readonly code: 'invalid-input'; readonly message: string }
  | { readonly code: 'channel-not-found'; readonly message: string }
  | { readonly code: 'send-failed'; readonly message: string }

/** Success branch. */
export interface DingtalkSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** Rejected branch. */
export interface DingtalkRejected<E extends DingtalkFailure> {
  readonly ok: false
  readonly error: E
}

/** Result union for each operation. */
export type DingtalkListResult = DingtalkSuccess<DingtalkListValue> | DingtalkRejected<DingtalkFailure>
export type DingtalkSaveResult = DingtalkSuccess<DingtalkSaveValue> | DingtalkRejected<DingtalkFailure>
export type DingtalkDeleteResult = DingtalkSuccess<DingtalkDeleteValue> | DingtalkRejected<DingtalkFailure>
export type DingtalkSetEnabledResult = DingtalkSuccess<DingtalkSetEnabledValue> | DingtalkRejected<DingtalkFailure>

/** Send a text message through one channel. */
export interface DingtalkSendRequest {
  readonly id: string
  readonly content: string
}

/** Whether the message was accepted by DingTalk. */
export interface DingtalkSendValue {
  readonly sent: boolean
  readonly detail?: string
}

export type DingtalkSendResult = DingtalkSuccess<DingtalkSendValue> | DingtalkRejected<DingtalkFailure>

/** Send a canned test message through one channel. */
export interface DingtalkTestRequest {
  readonly id: string
}

/** The response detail for a test send. */
export interface DingtalkTestValue {
  readonly ok: boolean
  readonly detail: string
}

export type DingtalkTestResult = DingtalkSuccess<DingtalkTestValue> | DingtalkRejected<DingtalkFailure>
