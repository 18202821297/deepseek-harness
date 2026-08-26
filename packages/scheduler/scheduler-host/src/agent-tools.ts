/**
 * Agent-facing tools for the Scheduler plugin.
 *
 * The scheduler service already exposes its operations as Remotes for the
 * client UI; this file wraps the same `ctx.scheduler` service methods as
 * model-callable tools so the agent can drive the plugin by chat — while the
 * user keeps the identical operations in the settings UI.
 *
 * Installed by SchedulerService (see index.ts) into every root agent scope:
 * it listens for `agent/created` and installs the tool set, so every manual
 * action stays available to the agent too.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {
  SchedulerDeleteRequest,
  SchedulerDeleteResult,
  SchedulerListChannelsResult,
  SchedulerListModelsResult,
  SchedulerListRequest,
  SchedulerListResult,
  SchedulerListSkillsResult,
  SchedulerRunNowRequest,
  SchedulerRunNowResult,
  SchedulerSaveRequest,
  SchedulerSaveResult,
  SchedulerSetEnabledRequest,
  SchedulerSetEnabledResult,
} from './types.ts'

/** Declare a JSON object output schema with compact model-facing rendering. */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Loose object envelope: the agent only needs the JSON, not a strict shape. */
const OBJECT_OUTPUT = { type: 'object', additionalProperties: true } as const
type SchedulerToolValue = InferValue<typeof OBJECT_OUTPUT>

/** Generic pending card for one tool call. */
function present(title: string, rawInput?: unknown): { card: 'generic'; title: string; kind: 'read' | 'other'; rawInput?: unknown } {
  return { card: 'generic', title, kind: 'other', ...rawInput === undefined ? {} : { rawInput } }
}

/** Map a Remote result to a flat tool value (value on success, {error,message} on failure). */
function flatten(result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }): unknown {
  return result.ok ? result.value : { error: result.error.code, message: result.error.message }
}

/** Install the Scheduler tool set in one exact Agent scope. */
function installSchedulerTools(ctx: Context, agent: Agent): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => void> = []

  disposers.push(scoped.tools.register(defineTool({
    name: 'scheduler_list_jobs',
    description: 'List every scheduled PVE collection job with its cron expression, enabled flag, target PVE server id, and last/next run times. Read-only; use to discover job ids before mutating.',
    parameters: {},
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(_args, exec): Promise<SchedulerToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as SchedulerToolValue
      const result = await ctx.scheduler.listJobs({} as SchedulerListRequest)
      return flatten(result as SchedulerListResult) as SchedulerToolValue
    },
    presentCall: () => present('List scheduler jobs'),
  })))

  disposers.push(scoped.tools.register(defineTool({
    name: 'scheduler_create_job',
    description: 'Create or replace one scheduled job. type is "pve" (run a PVE collection, optionally AI-analyze, push to channels) or "agent" (hand a prompt to the agent, push its reply). Supply a unique id, a human-readable name, a standard 5-field cron expression (minute hour day-of-month month day-of-week, e.g. "*/5 * * * *" for every 5 minutes). For pve jobs pass pveServerId (from pve_list_servers), optional aiEnabled, prompt, model, channelIds. For agent jobs pass prompt, optional skillName, model, channelIds. Creates the job with scheduling active unless enabled=false.',
    parameters: {
      id: { type: 'string', required: true, description: 'Unique job id, e.g. "pve-5min".' },
      name: { type: 'string', required: true, description: 'Human-readable job name.' },
      type: { type: 'string', required: true, enum: ['pve', 'agent'], description: 'pve or agent.' },
      cron: { type: 'string', required: true, description: 'Standard 5-field cron expression.' },
      pveServerId: { type: 'string', description: 'PVE server id (required for pve jobs).' },
      aiEnabled: { type: 'boolean', description: 'For pve jobs: run AI analysis before pushing.' },
      prompt: { type: 'string', description: 'Analysis guidance (pve) or full task prompt (agent).' },
      skillName: { type: 'string', description: 'Optional skill name injected into the execution context.' },
      model: { type: 'object', additionalProperties: true, description: 'Optional {provider, model} to use.' },
      channelIds: { type: 'array', items: { type: 'string' }, description: 'DingTalk channel ids to push results to.' },
      enabled: { type: 'boolean', description: 'Defaults to true; pass false to create disabled.' },
    },
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(args, exec): Promise<SchedulerToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as SchedulerToolValue
      const result = await ctx.scheduler.saveJob({ input: {
        id: args.id,
        name: args.name,
        type: args.type,
        cron: args.cron,
        pveServerId: args.pveServerId,
        aiEnabled: args.aiEnabled,
        prompt: args.prompt,
        skillName: args.skillName,
        model: args.model,
        channelIds: args.channelIds,
        enabled: args.enabled,
      } } as unknown as SchedulerSaveRequest)
      return flatten(result as SchedulerSaveResult) as SchedulerToolValue
    },
    presentCall: args => present('Create scheduler job', args),
  })))

  disposers.push(scoped.tools.register(defineTool({
    name: 'scheduler_set_enabled',
    description: 'Enable or disable one scheduled job. Disabled jobs are kept but never fire until re-enabled. Returns the updated job.',
    parameters: {
      id: { type: 'string', required: true, description: 'Job id from scheduler_list_jobs.' },
      enabled: { type: 'boolean', required: true, description: 'true to enable, false to disable.' },
    },
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(args, exec): Promise<SchedulerToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as SchedulerToolValue
      const result = await ctx.scheduler.setEnabled({ id: args.id, enabled: args.enabled } as SchedulerSetEnabledRequest)
      return flatten(result as SchedulerSetEnabledResult) as SchedulerToolValue
    },
    presentCall: args => present('Set scheduler job enabled', args),
  })))

  disposers.push(scoped.tools.register(defineTool({
    name: 'scheduler_delete_job',
    description: 'Delete one scheduled job permanently by id. Returns whether the job existed.',
    parameters: {
      id: { type: 'string', required: true, description: 'Job id from scheduler_list_jobs.' },
    },
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(args, exec): Promise<SchedulerToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as SchedulerToolValue
      const result = await ctx.scheduler.deleteJob({ id: args.id } as SchedulerDeleteRequest)
      return flatten(result as SchedulerDeleteResult) as SchedulerToolValue
    },
    presentCall: args => present('Delete scheduler job', args.id),
  })))

  disposers.push(scoped.tools.register(defineTool({
    name: 'scheduler_run_now',
    description: 'Fire one scheduled job immediately regardless of its cron schedule: run its pipeline now and push the result. Use to verify a job works end to end. Returns whether the run started.',
    parameters: {
      id: { type: 'string', required: true, description: 'Job id from scheduler_list_jobs.' },
    },
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(args, exec): Promise<SchedulerToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as SchedulerToolValue
      const result = await ctx.scheduler.runNow({ id: args.id } as SchedulerRunNowRequest)
      return flatten(result as SchedulerRunNowResult) as SchedulerToolValue
    },
    presentCall: args => present('Run scheduler job now', args.id),
  })))

  disposers.push(scoped.tools.register(defineTool({
    name: 'scheduler_list_channels',
    description: 'List available notification channels (DingTalk webhooks/robots) with their ids, names, and types. Use before creating a job to pick channelIds.',
    parameters: {},
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(_args, exec): Promise<SchedulerToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as SchedulerToolValue
      const result = await ctx.scheduler.listChannels({})
      return flatten(result as SchedulerListChannelsResult) as SchedulerToolValue
    },
    presentCall: () => present('List scheduler channels'),
  })))

  disposers.push(scoped.tools.register(defineTool({
    name: 'scheduler_list_models',
    description: 'List available LLM models (grouped by provider) for AI analysis / agent runs. Use before creating a job to pick a model.',
    parameters: {},
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(_args, exec): Promise<SchedulerToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as SchedulerToolValue
      const result = await ctx.scheduler.listModels({})
      return flatten(result as SchedulerListModelsResult) as SchedulerToolValue
    },
    presentCall: () => present('List scheduler models'),
  })))

  disposers.push(scoped.tools.register(defineTool({
    name: 'scheduler_list_skills',
    description: 'List available skills (name + description) that can be injected into a scheduled agent job. Use before creating an agent job to pick a skillName.',
    parameters: {},
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(_args, exec): Promise<SchedulerToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as SchedulerToolValue
      const result = await ctx.scheduler.listSkills({})
      return flatten(result as SchedulerListSkillsResult) as SchedulerToolValue
    },
    presentCall: () => present('List scheduler skills'),
  })))

  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/**
 * Install Scheduler tools into every live or subsequently published root agent
 * scope. Called once from SchedulerService init; returns a disposer that removes
 * all listeners and tool registrations (wired through `ctx.effect`).
 * @param ctx - Root service context owning agents and the scheduler service.
 */
export function registerSchedulerAgentTools(ctx: Context): () => void {
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || !ctx.agents.roots().includes(agent)) return
    installed.set(agent, installSchedulerTools(ctx, agent))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  const disposeCreated = ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  return () => {
    disposeCreated()
    disposeDisposed()
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }
}
