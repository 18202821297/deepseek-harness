/**
 * The PVE domain declaration. Two tables:
 * - `servers`: one record per monitored PVE server, keyed by server id;
 * - `task_state`: per-server collection state (already-reported UPIDs, last
 *   index line count for rotation detection), keyed by the SAME server id,
 *   so each server's dedup state is isolated from every other server's.
 * Records persist to the storage backend automatically — every put/delete is
 * durably committed before memory updates.
 * @module @deepseek-ai/dsh-pve-host/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Durable shape of one PVE server. `password` holds the encrypted form. */
export const serverRecord = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  /** AES-256-GCM encrypted password (blank when none). */
  password: z.string().default(''),
  /** Free-form operator note (no encryption; non-sensitive). */
  remark: z.string().default(''),
  enabled: z.boolean().default(true),
  /** Off = collection still runs but alerts are NOT delivered anywhere. */
  pushEnabled: z.boolean().default(true),
  channelIds: z.array(z.string()).default([]),
  aiEnabled: z.boolean().default(false),
  aiPrompt: z.string().default(''),
  aiModel: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored server record. */
export type ServerRecord = z.infer<typeof serverRecord>

/** How many already-reported UPIDs to keep per server (trimmed on write). */
export const MAX_TRACKED_UPIDS = 500

/**
 * Per-server collection state. `processedUpids` is a bounded, append-mostly
 * set of task UPIDs already reported; `lastIndexLines` detects index-file
 * rotation (a sudden line-count drop means `index` was rotated to `index.1`
 * and the rotated file must be re-read to not miss entries).
 */
export const taskStateRecord = z.object({
  processedUpids: z.array(z.string()).default([]),
  lastIndexLines: z.number().int().min(0).default(0),
})

/** One stored task-state record. */
export type TaskStateRecord = z.infer<typeof taskStateRecord>

/** The PVE domain spec. */
export const pveDomainSpec = defineDomain({
  name: 'pve',
  version: 1,
  tables: {
    servers: domainTable<ServerRecord['id'], ServerRecord>(serverRecord),
    task_state: domainTable<string, TaskStateRecord>(taskStateRecord),
  },
})
