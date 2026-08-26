import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * Storage-domain spec for the scheduler plugin.
 * Two fixed task types drive different execution pipelines:
 * - `pve`: run the PVE collector, optionally AI-analyze, push to channels.
 * - `agent`: hand a prompt to the agent, push the returned result.
 * Table names must match /^[a-z][a-z0-9_]*$/ (lowercase, digits, underscore).
 */
export const jobRecord = z.object({
  id: z.string().min(1),
  /** Human-readable job name shown in the UI and to the agent. */
  name: z.string().min(1),
  /** Fixed task type; each type has its own form and execution pipeline. */
  type: z.enum(['pve', 'agent']),
  /** Standard 5-field cron expression, e.g. every-5-minutes pattern. */
  cron: z.string().min(1),
  /** Master switch; disabled jobs are skipped by the tick loop but kept. */
  enabled: z.boolean().default(true),

  // ── pve-type fields ───────────────────────────────────────────────
  /** Target PVE server id (pve type only). */
  pveServerId: z.string().default(''),
  /** Run AI analysis over the collected failures before pushing. */
  aiEnabled: z.boolean().default(false),

  // ── shared execution fields ───────────────────────────────────────
  /** Provider+model for AI analysis / agent run; null = default selection. */
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }).nullable().default(null),
  /** User-authored prompt: AI-analysis guidance (pve) or full task prompt (agent). */
  prompt: z.string().default(''),
  /** Optional skill name injected into the execution context. */
  skillName: z.string().default(''),
  /** Notification channels to push results to (dingtalk channel ids). */
  channelIds: z.array(z.string()).default([]),

  /** Last successful fire timestamp (ISO) or null if never fired. */
  lastRunAt: z.string().nullable().default(null),
  /** Next fire timestamp (ISO) maintained by the tick loop, or null. */
  nextRunAt: z.string().nullable().default(null),
  /** Outcome of the last run: 'ok' | 'error' | null. */
  lastStatus: z.enum(['ok', 'error']).nullable().default(null),
  /** Human message for the last run (error detail or success summary). */
  lastMessage: z.string().nullable().default(null),
  /**
   * Bounded run history (newest first), capped at MAX_RUN_LOGS entries. One
   * entry per fire, recording when it ran and what the outcome was.
   */
  runLogs: z.array(z.object({
    at: z.string(),
    status: z.enum(['ok', 'error']),
    message: z.string(),
  })).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** How many past run records to keep per job (bounded, trimmed on write). */
export const MAX_RUN_LOGS = 200

export type JobRecord = z.infer<typeof jobRecord>

/**
 * Module-level singleton settings (UI-editable, persisted durably). The only
 * knob today is the global AI-analysis concurrency cap shared by every job.
 */
export const schedulerGlobalRecord = z.object({
  /** Max concurrent AI analyses across ALL jobs; 0 = unlimited. */
  aiConcurrency: z.number().int().min(0).max(20).default(4),
})
export type SchedulerGlobalRecord = z.infer<typeof schedulerGlobalRecord>

export const schedulerDomainSpec = defineDomain({
  name: 'scheduler',
  version: 1,
  global: {
    schema: schedulerGlobalRecord,
    initial: { aiConcurrency: 4 },
  },
  tables: {
    jobs: domainTable<JobRecord['id'], JobRecord>(jobRecord),
  },
})
