/**
 * Agent-facing PVE tools. The PVE collector already exposes its operations as
 * Remotes for the client UI; this plugin wraps the same `ctx.pve` service
 * methods as model-callable tools so the agent can list servers, trigger or
 * test a collection, and toggle a server's enabled / push flags by chat —
 * while the user keeps the identical operations in the settings UI.
 *
 * Installed by {@link PveService} (see index.ts) into every root agent scope:
 * the service listens for `agent/created` and installs the tool set, so every
 * manual action stays available to the agent too.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {
  PveCollectRequest,
  PveCollectResult,
  PveCollectTestRequest,
  PveCollectTestResult,
  PveListRequest,
  PveListResult,
  PveSetEnabledRequest,
  PveSetEnabledResult,
} from './types.ts'

/** Declare one canonical output schema with compact model-facing JSON. */
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

/** Value type the loose envelope promises the model. */
type PveToolValue = InferValue<typeof OBJECT_OUTPUT>

/** Generic pending card for one tool call. */
function present(title: string, rawInput?: unknown): { card: 'generic'; title: string; kind: 'read' | 'other'; rawInput?: unknown } {
  return { card: 'generic', title, kind: 'other', ...rawInput === undefined ? {} : { rawInput } }
}

/** Map a Remote result to a flat tool value (value on success, {error,message} on failure). */
function flatten(result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }): unknown {
  return result.ok ? result.value : { error: result.error.code, message: result.error.message }
}

/** Install the PVE tool set in one exact Agent scope. */
function installPveTools(ctx: Context, agent: Agent): () => void {
  const scoped = agent.ctx
  const disposers: Array<() => void> = []

  disposers.push(scoped.tools.register(defineTool({
    name: 'pve_list_servers',
    description: 'List every monitored PVE server with its API connection, enabled, and DingTalk-push flags. Read-only.',
    parameters: {},
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(_args, exec): Promise<PveToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as PveToolValue
      const result = await ctx.pve.listServers({} as PveListRequest)
      return flatten(result as PveListResult) as PveToolValue
    },
    presentCall: () => present('List PVE servers'),
  })))

  disposers.push(scoped.tools.register(defineTool({
    name: 'pve_collect_now',
    description: 'Run one collection for a PVE server now: query its recent tasks via the PVE API, diff new failed tasks, and deliver alerts through DingTalk (respecting the server push flag). Use after listing server ids.',
    parameters: {
      id: { type: 'string', required: true, description: 'Server id returned by pve_list_servers.' },
    },
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(args, exec): Promise<PveToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as PveToolValue
      const result = await ctx.pve.collectNow({ id: args.id } as PveCollectRequest)
      return flatten(result as PveCollectResult) as PveToolValue
    },
    presentCall: args => present('Collect PVE now', args.id),
  })))

  disposers.push(scoped.tools.register(defineTool({
    name: 'pve_collect_test',
    description: 'Probe a PVE server without sending any alert: read and parse its recent tasks via the PVE API, and report what WOULD be alerted. Use to validate credentials and preview the backlog.',
    parameters: {
      id: { type: 'string', required: true, description: 'Server id returned by pve_list_servers.' },
    },
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(args, exec): Promise<PveToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as PveToolValue
      const result = await ctx.pve.collectTest({ id: args.id } as PveCollectTestRequest)
      return flatten(result as PveCollectTestResult) as PveToolValue
    },
    presentCall: args => present('Test PVE collection', args.id),
  })))

  disposers.push(scoped.tools.register(defineTool({
    name: 'pve_set_enabled',
    description: 'Enable or disable one PVE server (stops/skips its collection and alerting). Returns whether the server was found.',
    parameters: {
      id: { type: 'string', required: true, description: 'Server id returned by pve_list_servers.' },
      enabled: { type: 'boolean', required: true, description: 'true to enable, false to disable.' },
    },
    output: jsonOutput(OBJECT_OUTPUT),
    async execute(args, exec): Promise<PveToolValue> {
      if (exec.agent !== agent) return { error: 'internal', message: 'agent scope mismatch' } as PveToolValue
      const result = await ctx.pve.setEnabled({ id: args.id, enabled: args.enabled } as PveSetEnabledRequest)
      return flatten(result as PveSetEnabledResult) as PveToolValue
    },
    presentCall: args => present('Set PVE server enabled', args),
  })))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Install PVE tools into every live or subsequently published root agent scope.
 * Called once from {@link PveService} init; returns a disposer that removes all
 * listeners and tool registrations (wired through `ctx.effect`).
 * @param ctx - Root service context owning agents and the pve service.
 */
export function registerPveAgentTools(ctx: Context): () => void {
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || !ctx.agents.roots().includes(agent)) return
    installed.set(agent, installPveTools(ctx, agent))
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
