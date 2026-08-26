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

/** Durable shape of one PVE server. `apiTokenSecret` holds the encrypted form. */
export const serverRecord = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * PVE API base URL, e.g. `https://10.0.0.1:8006`. Defaulted (not strictly
   * required) so records persisted by the pre-API schema (which had no API
   * fields) still load; `saveServer` still enforces a non-empty http(s) URL.
   */
  apiUrl: z.string().min(1).default(''),
  /**
   * PVE API token id, e.g. `root@pam!mytoken`. Defaulted for the same
   * legacy-record compatibility reason as `apiUrl`.
   */
  apiTokenId: z.string().min(1).default(''),
  /** AES-256-GCM encrypted API token secret (blank when none). */
  apiTokenSecret: z.string().default(''),
  /** PVE node name, e.g. `pve`. Defaulted for legacy-record compatibility. */
  node: z.string().min(1).default(''),
  /** Free-form operator note (no encryption; non-sensitive). */
  remark: z.string().default(''),
  enabled: z.boolean().default(true),
  /** Also collect node system logs (err/warning) alongside PVE task failures. */
  systemLogEnabled: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored server record. */
export type ServerRecord = z.infer<typeof serverRecord>

/** How many already-reported UPIDs to keep per server (trimmed on write). */
export const MAX_TRACKED_UPIDS = 500

/**
 * Per-server collection state. `processedUpids` is a bounded, append-mostly
 * set of task UPIDs already reported. `lastIndexLines` is retained for
 * storage compatibility with the file-based collector; in API mode it simply
 * mirrors the last task count and is not used for rotation detection.
 */
export const taskStateRecord = z.object({
  processedUpids: z.array(z.string()).default([]),
  lastIndexLines: z.number().int().min(0).default(0),
})

/** One stored task-state record. */
export type TaskStateRecord = z.infer<typeof taskStateRecord>

/** How many already-reported system-log hashes to keep per server (trimmed on write). */
export const MAX_TRACKED_SYSLOG_HASHES = 2000

/**
 * Per-server system-log collection state. System logs have no UPID, so dedup
 * uses a hash of (timestamp + unit + message). The collector scans a fixed
 * recent window each run and drops already-seen hashes.
 */
export const syslogStateRecord = z.object({
  processedHashes: z.array(z.string()).default([]),
})

/** One stored syslog-state record. */
export type SyslogStateRecord = z.infer<typeof syslogStateRecord>

/** The PVE domain spec. */
export const pveDomainSpec = defineDomain({
  name: 'pve',
  version: 1,
  tables: {
    servers: domainTable<ServerRecord['id'], ServerRecord>(serverRecord),
    task_state: domainTable<string, TaskStateRecord>(taskStateRecord),
    syslog_state: domainTable<string, SyslogStateRecord>(syslogStateRecord),
  },
})
