/**
 * Public request, value, and failure vocabulary for the PVE collector Remote.
 * Types only — generated Remote clients consume this without importing Host
 * runtime code.
 * @module @deepseek-ai/dsh-pve-host/types
 */

/**
 * One PVE server the collector talks to over the PVE REST API. The token
 * secret is stored encrypted at rest; it never crosses the Remote boundary
 * (only the masked form does).
 */
export interface PveServer {
  readonly id: string
  readonly name: string
  /** PVE API base URL, e.g. `https://10.0.0.1:8006`. */
  readonly apiUrl: string
  /** PVE API token id, e.g. `root@pam!mytoken`. */
  readonly apiTokenId: string
  /** Masked form only (e.g. `abcd••••`); the plaintext stays in the Host. */
  readonly apiTokenSecret: string
  /** PVE node name, e.g. `pve`. */
  readonly node: string
  /** Free-form operator note (location, purpose, etc.). */
  readonly remark: string
  readonly enabled: boolean
  /** Also collect node system logs (err/warning) alongside PVE task failures. */
  readonly systemLogEnabled: boolean
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
  /** PVE API base URL, e.g. `https://10.0.0.1:8006`. */
  readonly apiUrl: string
  /** PVE API token id, e.g. `root@pam!mytoken`. */
  readonly apiTokenId: string
  /** Blank when editing = keep the stored token secret unchanged. */
  readonly apiTokenSecret?: string
  /** PVE node name, e.g. `pve`. */
  readonly node: string
  /** Operator note; blank when editing = keep the stored value. */
  readonly remark?: string
  readonly enabled?: boolean
  /** Collect node system logs too; blank when editing = keep the stored value. */
  readonly systemLogEnabled?: boolean
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

/** Run one collection immediately (manual button / scheduler entry). */
export interface PveCollectRequest {
  readonly id: string
}

/** One failed task surfaced by a collection / collect-test run. */
export interface PveCollectTask {
  readonly upid: string
  readonly type: string
  readonly target: string
  readonly user: string
  readonly status: string
  /** Raw task log body (fetched via the PVE task-log API), when fetched (truncated). */
  readonly log?: string
}

/** One node system-log line (err/warning) surfaced by a run. */
export interface PveSystemLogEntry {
  /** Realtime timestamp (ISO-8601) of the journal entry. */
  readonly ts: string
  /** Emitting unit / syslog identifier, e.g. `zfs-zed` or `corosync`. */
  readonly unit: string
  /** Priority label: `err` (PRIORITY 0-3) or `warning` (4). */
  readonly priority: string
  /** The raw log message. */
  readonly message: string
}

/** What one collection run produced. */
export interface PveCollectValue {
  /** New failed tasks this run (after dedup); the scheduler composes alerts from these. */
  readonly reported: number
  /** Failed tasks skipped because they were already reported before. */
  readonly skipped: number
  /** First line of the last error, or empty on success. */
  readonly error: string
  /** Fresh failed-task entries, when the collector exposed them. */
  readonly fresh?: readonly PveCollectTask[]
  /** New node system-log entries this run (when system-log collection is enabled). */
  readonly systemLogs?: readonly PveSystemLogEntry[]
  /** Dedup hashes of `systemLogs`, same order — the scheduler confirms these after a successful push. */
  readonly systemHashes?: readonly string[]
  /** Count of new system-log entries (after dedup). */
  readonly systemReported: number
}

/** Confirm one batch as delivered: mark these tasks/logs as reported. */
export interface PveConfirmRequest {
  readonly id: string
  /** Task UPIDs that were actually pushed; marked reported so they never re-fire. */
  readonly upids?: readonly string[]
  /** System-log hashes that were actually pushed; marked reported so they never re-fire. */
  readonly syslogHashes?: readonly string[]
}

export interface PveConfirmValue {
  readonly markedUpids: number
  readonly markedHashes: number
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
  /** Raw task log body (fetched via the PVE task-log API), when fetched (truncated). */
  readonly log?: string
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
  /** How many fresh tasks this probe surfaced. */
  readonly wouldReport: number
  /** New node system-log entries that would be alerted (when enabled). */
  readonly systemLogs: readonly PveSystemLogEntry[]
  /** How many new system-log entries this probe surfaced. */
  readonly systemReported: number
  /** Always true: push decisions now live in the scheduler plugin. */
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
export type PveCollectResult = PveSuccess<PveCollectValue> | PveRejected<PveFailure>
export type PveConfirmResult = PveSuccess<PveConfirmValue> | PveRejected<PveFailure>
export type PveCollectTestResult = PveSuccess<PveCollectTestValue> | PveRejected<PveFailure>
export type PveListModelsResult = PveSuccess<PveListModelsValue> | PveRejected<PveFailure>
