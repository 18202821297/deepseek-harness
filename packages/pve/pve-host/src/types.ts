/**
 * Public request, value, and failure vocabulary for the PVE collector Remote.
 * Types only — generated Remote clients consume this without importing Host
 * runtime code.
 * @module @deepseek-ai/dsh-pve-host/types
 */

/**
 * One PVE server the collector SSHes into. The password is stored encrypted
 * at rest; it never crosses the Remote boundary (only the masked form does).
 */
export interface PveServer {
  readonly id: string
  readonly name: string
  readonly host: string
  readonly port: number
  readonly username: string
  /** Masked form only (e.g. `abcd••••`); the plaintext stays in the Host. */
  readonly password: string
  /** Free-form operator note (location, purpose, etc.). */
  readonly remark: string
  readonly enabled: boolean
  /** Off = collection still runs but alerts are not delivered anywhere. */
  readonly pushEnabled: boolean
  /** Ids of message channels (DingTalk) to deliver alerts to. */
  readonly channelIds: readonly string[]
  readonly aiEnabled: boolean
  /** Prompt for the optional AI analysis; used only when aiEnabled. */
  readonly aiPrompt: string
  /** Model for the AI analysis; absent = deployment default. */
  readonly aiModel: PveModelRef | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** A provider+model pair referencing the harness model catalog. */
export interface PveModelRef {
  readonly provider: string
  readonly model: string
}

/** One provider with its enumerable models, for the card's model dropdown. */
export interface PveModelGroup {
  readonly provider: string
  readonly models: readonly string[]
}

/** Input accepted when creating or updating one server. */
export interface PveServerInput {
  readonly id: string
  readonly name: string
  readonly host: string
  readonly port: number
  readonly username: string
  /** Blank when editing = keep the stored password unchanged. */
  readonly password?: string
  /** Operator note; blank when editing = keep the stored value. */
  readonly remark?: string
  readonly enabled?: boolean
  readonly pushEnabled?: boolean
  readonly channelIds?: readonly string[]
  readonly aiEnabled?: boolean
  readonly aiPrompt?: string
  readonly aiModel?: PveModelRef | null
}

/** Read all servers. */
export interface PveListRequest {
  readonly _?: never
}

export interface PveListValue {
  readonly servers: readonly PveServer[]
}

/** Create or replace one server. */
export interface PveSaveRequest {
  readonly input: PveServerInput
}

export type PveSaveValue = PveServer

/** Delete one server by id. */
export interface PveDeleteRequest {
  readonly id: string
  /** When true, also delete this server's dedup state (already-reported tasks will re-fire once). */
  readonly removeState?: boolean
}

export interface PveDeleteValue {
  readonly deleted: boolean
}

/** Toggle a server's enabled flag. */
export interface PveSetEnabledRequest {
  readonly id: string
  readonly enabled: boolean
}

export type PveSetEnabledValue =
  | { readonly found: true; readonly server: PveServer }
  | { readonly found: false }

/** Toggle a server's push-to-DingTalk flag. */
export interface PveSetPushEnabledRequest {
  readonly id: string
  readonly pushEnabled: boolean
}

export type PveSetPushEnabledValue =
  | { readonly found: true; readonly server: PveServer }
  | { readonly found: false }

/** Run one collection immediately (manual button / future scheduler entry). */
export interface PveCollectRequest {
  readonly id: string
}

/** What one collection run produced. */
export interface PveCollectValue {
  /** Alerts delivered this run (after dedup). */
  readonly reported: number
  /** Failed tasks skipped because they were already reported before. */
  readonly skipped: number
  /** First line of the last error, or empty on success. */
  readonly error: string
}

/** List the harness model catalog for the AI-analysis dropdown. */
export interface PveListModelsRequest {
  readonly _?: never
}

export interface PveListModelsValue {
  readonly groups: readonly PveModelGroup[]
}

/** One failed task surfaced by a collect-test probe. */
export interface PveCollectTestTask {
  readonly upid: string
  readonly type: string
  readonly target: string
  readonly user: string
  readonly status: string
}

/** Probe one server without sending anything (connect + parse + dedup diff). */
export interface PveCollectTestRequest {
  readonly id: string
}

/** What a collect-test probe found. `ok:false` carries the connection/read error. */
export interface PveCollectTestValue {
  readonly ok: boolean
  /** Connection or read failure reason; empty when ok. */
  readonly error: string
  /** Lines read from the task index (plus index.1 on rotation). */
  readonly lines: number
  /** Total parsed task entries. */
  readonly entries: number
  /** New failed tasks that would be alerted, in file order. */
  readonly fresh: readonly PveCollectTestTask[]
  /** How many would be delivered given the current pushEnabled flag. */
  readonly wouldReport: number
  /** The current push-to-DingTalk flag of this server. */
  readonly pushEnabled: boolean
}

/** A concrete business failure. */
export type PveFailure =
  | { readonly code: 'invalid-input'; readonly message: string }
  | { readonly code: 'server-not-found'; readonly message: string }

/** Success branch. */
export interface PveSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** Rejected branch. */
export interface PveRejected<E extends PveFailure> {
  readonly ok: false
  readonly error: E
}

/** Result union for each operation. */
export type PveListResult = PveSuccess<PveListValue> | PveRejected<PveFailure>
export type PveSaveResult = PveSuccess<PveSaveValue> | PveRejected<PveFailure>
export type PveDeleteResult = PveSuccess<PveDeleteValue> | PveRejected<PveFailure>
export type PveSetEnabledResult = PveSuccess<PveSetEnabledValue> | PveRejected<PveFailure>
export type PveSetPushEnabledResult = PveSuccess<PveSetPushEnabledValue> | PveRejected<PveFailure>
export type PveCollectResult = PveSuccess<PveCollectValue> | PveRejected<PveFailure>
export type PveCollectTestResult = PveSuccess<PveCollectTestValue> | PveRejected<PveFailure>
export type PveListModelsResult = PveSuccess<PveListModelsValue> | PveRejected<PveFailure>
