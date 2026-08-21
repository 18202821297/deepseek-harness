/**
 * Drive one DSH agent turn from an incoming DingTalk @-message, then return
 * the assistant's final text so the caller can post it back to the group.
 *
 * Flow (per the official turn lifecycle):
 *   1. create an agent for this robot channel (stable session id keeps
 *      context across messages in the same group),
 *   2. `agent.followup(message)` submits the user message,
 *   3. collect `session/event` `assistant/message` events for this turn,
 *   4. join the text content blocks into one reply.
 * @module @deepseek-ai/dsh-dingtalk-host/src/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** A stable session id per robot channel so conversation context persists. */
function sessionIdFor(channelId: string): SessionId {
  return `dingtalk-${channelId}` as SessionId
}

/**
 * The dedicated, stable workspace directory for one robot channel, rooted under
 * `$DSH_HOME/workspaces/dingtalk/<channelId>`. The directory name is the
 * channelId, which matches the stable session id `dingtalk-<channelId>` — so a
 * channel's agent cwd and its persisted session history always stay aligned.
 * Editing a channel keeps the same id, so the directory is never mis-mapped.
 * @param channelId the robot channel id (UUID from the client)
 * @returns the absolute workspace directory path
 */
export function dingtalkWorkspaceDir(channelId: string): string {
  return dshHomePath('workspaces', 'dingtalk', channelId)
}

/** Extract the text content from an assistant message's content blocks. */
function textFromContent(blocks: readonly { type: string }[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && 'text' in b)
    .map(b => b.text)
    .join('')
}

/**
 * Run one agent turn and resolve the assistant's text reply.
 * @param ctx the plugin context (has `agents` + session event bus)
 * @param agentPreset the DSH agent preset id (e.g. "standard")
 * @param channelId the robot channel id (drives the stable session id)
 * @param content the trimmed @-message text
 * @returns the assistant reply, or an error message if the turn failed.
 */
export async function runAgentTurn(
  ctx: Context,
  agentPreset: string,
  channelId: string,
  content: string,
): Promise<string> {
  const sessionId = sessionIdFor(channelId)
  // Optional service access: agent support is a capability, not a hard
  // dependency — a runtime without ctx.agents degrades to an error reply
  // instead of failing to load the whole channel store.
  const agents = ctx.reflect.get('agents', false) as
    | {
      create(options: unknown): Promise<{ agent: Agent; dispose(): void }>
      resume(options: unknown): Promise<{ agent: Agent; dispose(): void }>
    }
    | undefined
  if (agents === undefined) {
    return 'error: DSH agent service is not available in this runtime'
  }

  // The plugin drives the agent at the low level, so the model-selection
  // waterfall ApiProxy/headless install is not automatic: without it the
  // `{{model}}` prompt variable stays unset and prompt assembly throws,
  // ending the turn with no assistant output. Install it from the deployment
  // default (the settings `agent-default-model` section), for both a fresh
  // create and a cold resume.
  const setup = (agentCtx: Context): void => {
    const defaults = ctx.reflect.get('agentDefaultModel', false) as
      | { currentSelection(): ModelSelection }
      | undefined
    const selected: ModelSelectionRef = {
      get current() { return defaults?.currentSelection() },
      assembled: undefined,
    }
    installModelSelection(agentCtx, selected)
  }

  // The session id is stable per channel, so a previously persisted log for
  // it blocks `create` (id collision): resume the persisted session to keep
  // group context, and only create when nothing is stored yet.
  const persistence = ctx.reflect.get('sessionPersistence', false) as
    | { list(): Promise<readonly { id: string }[]> }
    | undefined
  const persisted = persistence === undefined
    ? undefined
    : (await persistence.list()).find(header => header.id === sessionId)
  // Each robot channel owns a dedicated, stable workspace directory under
  // `$DSH_HOME/workspaces/dingtalk/<channelId>` (see dingtalkWorkspaceDir):
  // the agent cwd and the channel's session id share the same channelId, so
  // conversation history stays aligned with the files on disk. We never borrow
  // the deployment's first workspace or the launch directory.
  const cwd = dingtalkWorkspaceDir(channelId)
  const handle = persisted !== undefined
    ? await agents.resume({ resumeSessionId: sessionId, setup })
    : await agents.create({ sessionId, meta: { cwd, agentPreset }, setup })

  try {
    const agent: Agent = handle.agent
    console.log(`[dingtalk-agent] created sessionId=${agent.session.id} want=${sessionId}`)
    return await collectReply(ctx, sessionId, () => {
      const message = createUserMessage({
        content: [{ type: 'text', text: content }],
        source: { kind: 'plugin', plugin: 'dingtalk' },
      })
      agent.followup(message)
    })
  } finally {
    handle.dispose()
  }
}

/** Listen to session/event for the assistant's message after submitting input. */
function collectReply(
  ctx: Context,
  sessionId: SessionId,
  submit: () => void,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const parts: string[] = []
    let settled = false

    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stopListening()
      resolve(parts.join('').trim() || '(no reply)')
    }

    const onEvent = (session: Session, event: SessionEvent): void => {
      console.log(`[dingtalk-agent] event session=${session.id} want=${sessionId} type=${event.type}`)
      if (session.id !== sessionId) return
      if (event.type === 'assistant/message') {
        const blocks = (event.data as { message: { content: readonly { type: string }[] } }).message.content
        const text = textFromContent(blocks)
        if (text !== '') parts.push(text)
      } else if (event.type === 'assistant/chunk') {
        const text = (event.data as { delta?: string; text?: string }).delta ?? (event.data as { delta?: string; text?: string }).text ?? ''
        if (text !== '') parts.push(text)
      } else if (event.type === 'turn/end') {
        console.log(`[dingtalk-agent] turn/end reason=${JSON.stringify(event.data)}`)
        settle()
      } else if (event.type === 'user/message') {
        console.log('[dingtalk-agent] user/message processed')
      }
    }

    const timer = setTimeout(() => settle(), 120_000)

    const stopListening = ctx.on('session/event', onEvent)
    submit()
  })
}
