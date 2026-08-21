/**
 * DingTalk message sending for both channel kinds.
 *
 * - webhook (group custom robot): POST the text body to the robot's webhook
 *   URL, optionally HMAC-SHA256-signed with the secret appended to the URL.
 * - app (enterprise-internal-app robot): first exchange appKey/appSecret for
 *   an access_token at oapi.dingtalk.com, then POST the text body to the
 *   robot/send endpoint.
 *
 * `fetch` is injected so unit tests can stub the network without any real
 * DingTalk calls.
 * @module @deepseek-ai/dsh-dingtalk-host/src/send
 */

import { createHmac } from 'node:crypto'
import type { DingtalkChannel } from './types.ts'

/** DingTalk's robot text-message body. */
export interface DingtalkTextBody {
  readonly msgtype: 'text'
  readonly text: { readonly content: string }
}

/** Base URL for DingTalk Open API. */
export const DINGTALK_BASE = 'https://oapi.dingtalk.com'

/** A minimal fetch-like signature so tests can inject a stub. */
export type FetchLike = (url: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
}>

/**
 * Build the signed webhook URL for a custom robot with a secret.
 * sign = base64(hmacSha256(timestamp + "\n" + secret, secret))
 * @param webhookUrl the raw robot webhook URL
 * @param secret the signing secret (empty = no signing)
 * @param now timestamp in ms, injectable for deterministic tests
 */
export function signedWebhookUrl(webhookUrl: string, secret: string, now = Date.now()): string {
  if (secret === '') return webhookUrl
  const timestamp = now
  const stringToSign = `${timestamp}\n${secret}`
  const sign = createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64')
  const url = new URL(webhookUrl)
  url.searchParams.set('timestamp', String(timestamp))
  // URLSearchParams percent-encodes the value itself; do NOT encodeURIComponent
  // here or the base64 '=' becomes double-encoded (%253D) and DingTalk rejects.
  url.searchParams.set('sign', sign)
  return url.toString()
}

/** Exchange appKey/appSecret for an enterprise-internal-app access_token. */
export async function fetchAppToken(appKey: string, appSecret: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const url = `${DINGTALK_BASE}/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`
  const res = await fetchImpl(url)
  const body = await res.text()
  if (!res.ok) throw new Error(`gettoken failed: HTTP ${res.status} ${body}`)
  let parsed: { errcode?: number; errmsg?: string; access_token?: string } = {}
  try {
    parsed = JSON.parse(body) as { errcode?: number; errmsg?: string; access_token?: string }
  } catch {
    throw new Error(`gettoken returned non-JSON: ${body}`)
  }
  if (parsed.errcode !== 0 || parsed.access_token === undefined) {
    throw new Error(`gettoken rejected: ${parsed.errmsg ?? body}`)
  }
  return parsed.access_token
}

/**
 * Validate app credentials by exchanging them for an access_token. Throws on
 * any failure so callers can surface the DingTalk error; returns void on
 * success. Used by `testChannel` for Stream-robot channels.
 */
export async function testAppCredentials(appKey: string, appSecret: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await fetchAppToken(appKey, appSecret, fetchImpl)
}

/**
 * Send a text message through one channel. Throws on any network/API failure
 * with a human-readable message; the caller maps it to `send-failed`.
 */
export async function sendText(
  channel: DingtalkChannel,
  content: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (channel.type === 'webhook') {
    const url = signedWebhookUrl(channel.webhookUrl, channel.secret)
    await postText(url, content, fetchImpl)
    return
  }
  // Stream-mode robot is a receive-side channel (group @-mentions drive a
  // session); it does not push arbitrary messages, so there is no outbound
  // "send" to implement here.
  throw new Error('stream-mode robot does not send push messages')
}

/** POST the text body and check DingTalk's errcode response. */
async function postText(url: string, content: string, fetchImpl: FetchLike): Promise<void> {
  const body: DingtalkTextBody = { msgtype: 'text', text: { content } }
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`send failed: HTTP ${res.status} ${raw}`)
  let parsed: { errcode?: number; errmsg?: string } = {}
  try {
    parsed = JSON.parse(raw) as { errcode?: number; errmsg?: string }
  } catch {
    throw new Error(`send returned non-JSON: ${raw}`)
  }
  if (parsed.errcode !== 0) {
    throw new Error(`send rejected: ${parsed.errmsg ?? raw}`)
  }
}
