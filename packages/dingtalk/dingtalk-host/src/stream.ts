/**
 * DingTalk Stream-mode robot connection manager.
 *
 * Each enabled app-type channel gets a `DWClient` long connection to
 * DingTalk's Stream gateway (no public endpoint needed). Group @-mentions
 * arrive on the `/v1.0/im/bot/messages/get` topic; the callback hands the
 * text content to the configured handler.
 *
 * The real clientSecret is decrypted from the stored record before connecting
 * — it never crosses the Remote boundary.
 * @module @deepseek-ai/dsh-dingtalk-host/src/stream
 */

import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import type { DingtalkAppChannel } from './types.ts'

/** What to do with one received group @-message. */
export interface StreamMessageHandler {
  (message: {
    conversationId: string
    content: string
    senderNick: string
    msgId: string
    /** Reply webhook for this session (POST text back to the group). */
    sessionWebhook: string
  }): void | Promise<void>
}

/** One live Stream connection. */
export interface StreamConnection {
  readonly client: DWClient
  disconnect: () => void
}

/** Map of channelId → live connection. */
export type StreamConnections = Map<string, StreamConnection>

/**
 * Open a Stream connection for one app channel. The clientSecret here is the
 * decrypted plaintext (caller decrypts from storage).
 * @returns a controller with disconnect(), or null if the secret is missing.
 */
export function connectStream(
  channel: DingtalkAppChannel,
  plainSecret: string,
  onMessage: StreamMessageHandler,
): StreamConnection | null {
  if (plainSecret === '') return null
  const client = new DWClient({
    clientId: channel.clientId,
    clientSecret: plainSecret,
    debug: true,
  })
  client.registerCallbackListener(TOPIC_ROBOT, async (downStream) => {
    // Log the raw frame before any parsing so a delivery is always visible.
    console.log('[dingtalk-stream] raw callback:', JSON.stringify(downStream).slice(0, 300))
    try {
      const data = JSON.parse(downStream.data ?? '{}') as {
        conversationId?: string
        text?: { content?: string }
        senderNick?: string
        msgId?: string
        sessionWebhook?: string
      }
      onMessage({
        conversationId: data.conversationId ?? '',
        content: (data.text?.content ?? '').trim(),
        senderNick: data.senderNick ?? '',
        msgId: data.msgId ?? '',
        sessionWebhook: data.sessionWebhook ?? '',
      })
    } catch (error) {
      // A malformed message must not take the connection down.
      console.error('[dingtalk-stream] message parse failed:', error)
    }
  })
  client.on?.('error', (error: unknown) => {
    console.error('[dingtalk-stream] connection error:', error)
  })
  void client.connect()
  return {
    client,
    disconnect: () => client.disconnect(),
  }
}
