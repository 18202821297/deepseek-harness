/**
 * Scheduler client, main entry.
 *
 * Deliberately empty Host body: the Scheduler service lives in the separate
 * `@deepseek-ai/dsh-scheduler-host` package. The browser half renders the settings UI over
 * `ctx.remote.scheduler` via the client face (`./client/index.ts`).
 */
export function apply(): void {}
