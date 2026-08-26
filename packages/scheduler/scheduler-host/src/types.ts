/**
 * Public request, value, and failure vocabulary for the Scheduler Remote.
 * @module @deepseek-ai/dsh-scheduler-host/types
 */

/** One recorded run in a job's bounded run history. */
export interface SchedulerRunLog {
  readonly at: string
  readonly status: 'ok' | 'error'
  readonly message: string
}

export interface SchedulerJob {
  readonly id: string
  readonly name: string
  readonly type: 'pve' | 'agent'
  readonly cron: string
  readonly enabled: boolean
  readonly pveServerId: string
  readonly aiEnabled: boolean
  readonly model: { readonly provider: string; readonly model: string } | null
  readonly prompt: string
  readonly skillName: string
  readonly channelIds: readonly string[]
  readonly lastRunAt: string | null
  readonly nextRunAt: string | null
  readonly lastStatus: 'ok' | 'error' | null
  readonly lastMessage: string | null
  readonly runLogs: readonly SchedulerRunLog[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SchedulerJobInput {
  readonly id: string
  readonly name: string
  readonly type: 'pve' | 'agent'
  readonly cron: string
  readonly enabled?: boolean
  readonly pveServerId?: string
  readonly aiEnabled?: boolean
  readonly model?: { readonly provider: string; readonly model: string } | null
  readonly prompt?: string
  readonly skillName?: string
  readonly channelIds?: readonly string[]
}

/** Module-level settings (persisted as the domain's global record). */
export interface SchedulerSettings {
  /** Global cap on concurrent AI analyses across all jobs; 0 = unlimited. */
  readonly aiConcurrency: number
}

/** Read the module settings. */
export interface SchedulerGetSettingsRequest { readonly _?: never }
export type SchedulerGetSettingsValue = SchedulerSettings

/** Save the module settings (applied immediately). */
export interface SchedulerSaveSettingsRequest { readonly aiConcurrency: number }
export type SchedulerSaveSettingsValue = SchedulerSettings

/** Lightweight PVE server reference for the job-target dropdown. */
export interface SchedulerPveServerRef {
  readonly id: string
  readonly name: string
}

/** Lightweight notification-channel reference for the channel multi-select. */
export interface SchedulerChannelRef {
  readonly id: string
  readonly name: string
  readonly type: string
}

/** Lightweight model reference for the model dropdown. */
export interface SchedulerModelRef {
  readonly provider: string
  readonly model: string
}

/** Read all jobs, newest first. */
export interface SchedulerListRequest { readonly _?: never }
export interface SchedulerListValue { readonly jobs: readonly SchedulerJob[] }

/** Create or replace one job. */
export interface SchedulerSaveRequest { readonly input: SchedulerJobInput }
export type SchedulerSaveValue = SchedulerJob

/** Delete one job by id. */
export interface SchedulerDeleteRequest { readonly id: string }
export interface SchedulerDeleteValue { readonly deleted: boolean }

/** Toggle one job's enabled flag. */
export interface SchedulerSetEnabledRequest { readonly id: string; readonly enabled: boolean }
export interface SchedulerSetEnabledValue { readonly job: SchedulerJob }

/** Fire one job immediately regardless of schedule. */
export interface SchedulerRunNowRequest { readonly id: string }
export interface SchedulerRunNowValue { readonly id: string; readonly started: boolean }

/** List PVE servers for the job-target dropdown. */
export interface SchedulerListPveServersRequest { readonly _?: never }
export interface SchedulerListPveServersValue { readonly servers: readonly SchedulerPveServerRef[] }

/** List notification channels for the channel multi-select. */
export interface SchedulerListChannelsRequest { readonly _?: never }
export interface SchedulerListChannelsValue { readonly channels: readonly SchedulerChannelRef[] }

/** List available models for the model dropdown. */
export interface SchedulerListModelsRequest { readonly _?: never }
export interface SchedulerListModelsValue { readonly groups: readonly SchedulerModelGroup[] }
export interface SchedulerModelGroup {
  readonly name: string
  readonly models: readonly SchedulerModelRef[]
}

/** Lightweight skill reference for the skill picker. */
export interface SchedulerSkillRef {
  readonly name: string
  readonly description: string
}

/** List available skills for the skill picker card window. */
export interface SchedulerListSkillsRequest { readonly _?: never }
export interface SchedulerListSkillsValue { readonly skills: readonly SchedulerSkillRef[] }

/** Concrete business failures. */
export type SchedulerFailure =
  | { readonly code: 'invalid-input'; readonly message: string }
  | { readonly code: 'invalid-cron'; readonly message: string }
  | { readonly code: 'not-found'; readonly message: string }
  | { readonly code: 'pve-unavailable'; readonly message: string }
  | { readonly code: 'channel-unavailable'; readonly message: string }
  | { readonly code: 'model-unavailable'; readonly message: string }

export interface SchedulerSuccess<T> { readonly ok: true; readonly value: T }
export interface SchedulerRejected<E extends SchedulerFailure> { readonly ok: false; readonly error: E }

export type SchedulerListResult = SchedulerSuccess<SchedulerListValue> | SchedulerRejected<SchedulerFailure>
export type SchedulerSaveResult = SchedulerSuccess<SchedulerSaveValue> | SchedulerRejected<SchedulerFailure>
export type SchedulerDeleteResult = SchedulerSuccess<SchedulerDeleteValue> | SchedulerRejected<SchedulerFailure>
export type SchedulerSetEnabledResult = SchedulerSuccess<SchedulerSetEnabledValue> | SchedulerRejected<SchedulerFailure>
export type SchedulerRunNowResult = SchedulerSuccess<SchedulerRunNowValue> | SchedulerRejected<SchedulerFailure>
export type SchedulerGetSettingsResult = SchedulerSuccess<SchedulerGetSettingsValue> | SchedulerRejected<SchedulerFailure>
export type SchedulerSaveSettingsResult = SchedulerSuccess<SchedulerSaveSettingsValue> | SchedulerRejected<SchedulerFailure>
export type SchedulerListPveServersResult = SchedulerSuccess<SchedulerListPveServersValue> | SchedulerRejected<SchedulerFailure>
export type SchedulerListChannelsResult = SchedulerSuccess<SchedulerListChannelsValue> | SchedulerRejected<SchedulerFailure>
export type SchedulerListModelsResult = SchedulerSuccess<SchedulerListModelsValue> | SchedulerRejected<SchedulerFailure>
export type SchedulerListSkillsResult = SchedulerSuccess<SchedulerListSkillsValue> | SchedulerRejected<SchedulerFailure>
