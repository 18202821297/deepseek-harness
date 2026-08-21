/**
 * Unit tests for the DingTalk send module — the network layer is stubbed,
 * so these verify URL construction, HMAC signing, token exchange, and error
 * handling without any real DingTalk calls.
 */
import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import type { DingtalkChannel } from '../src/types.ts'
import { fetchAppToken, sendText, signedWebhookUrl, testAppCredentials } from '../src/send.ts'
import type { FetchLike } from '../src/send.ts'

function webhookChannel(overrides: Partial<DingtalkChannel> = {}): DingtalkChannel {
  return {
    id: 'w1', name: 'webhook', type: 'webhook',
    webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
    secret: '', enabled: true,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as DingtalkChannel
}

function appChannel(overrides: Partial<DingtalkChannel> = {}): DingtalkChannel {
  return {
    id: 'a1', name: 'app', type: 'app',
    clientId: 'k', clientSecret: '••••', enabled: true,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as DingtalkChannel
}

/** A fetch stub that records calls and returns a scripted response. */
function stubFetch(
  responses: Array<{ ok?: boolean; status?: number; body: string }>,
): { fetch: FetchLike; calls: Array<{ url: string; body?: string }> } {
  const calls: Array<{ url: string; body?: string }> = []
  const fetch: FetchLike = async (url, init) => {
    const u = String(url)
    const b = init?.body
    calls.push(b === undefined ? { url: u } : { url: u, body: b })
    const r = responses.shift() ?? { ok: true, status: 200, body: '{"errcode":0,"errmsg":"ok"}' }
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => r.body,
    }
  }
  return { fetch, calls }
}

describe('signedWebhookUrl', () => {
  it('returns the raw URL when no secret', () => {
    expect(signedWebhookUrl('https://x.com/hook', '')).toBe('https://x.com/hook')
  })

  it('appends timestamp + sign when a secret is set', () => {
    const url = signedWebhookUrl('https://x.com/hook', 'SECRET', 1234567890)
    const parsed = new URL(url)
    expect(parsed.searchParams.get('timestamp')).toBe('1234567890')
    expect(parsed.searchParams.get('sign')).toBeTruthy()
    // sign = base64(hmac-sha256("1234567890\nSECRET", SECRET))
    const expected = createHmac('sha256', 'SECRET').update('1234567890\nSECRET', 'utf8').digest('base64')
    expect(parsed.searchParams.get('sign')).toBe(expected)
  })
})

describe('fetchAppToken', () => {
  it('returns the access_token on success', async () => {
    const { fetch } = stubFetch([{ body: '{"errcode":0,"access_token":"TOK"}' }])
    await expect(fetchAppToken('k', 's', fetch)).resolves.toBe('TOK')
  })

  it('throws when errcode is non-zero', async () => {
    const { fetch } = stubFetch([{ body: '{"errcode":40013,"errmsg":"invalid appkey"}' }])
    await expect(fetchAppToken('k', 's', fetch)).rejects.toThrow(/invalid appkey/)
  })

  it('throws on HTTP error', async () => {
    const { fetch } = stubFetch([{ ok: false, status: 500, body: 'boom' }])
    await expect(fetchAppToken('k', 's', fetch)).rejects.toThrow(/HTTP 500/)
  })
})

describe('testAppCredentials', () => {
  it('resolves when the token exchange succeeds', async () => {
    const { fetch } = stubFetch([{ body: '{"errcode":0,"access_token":"TOK"}' }])
    await expect(testAppCredentials('k', 's', fetch)).resolves.toBeUndefined()
  })

  it('rejects when the token exchange fails', async () => {
    const { fetch } = stubFetch([{ body: '{"errcode":40013,"errmsg":"invalid appkey"}' }])
    await expect(testAppCredentials('k', 's', fetch)).rejects.toThrow(/invalid appkey/)
  })
})

describe('sendText', () => {
  it('posts the text body to the webhook URL without secret', async () => {
    const { fetch, calls } = stubFetch([{ body: '{"errcode":0,"errmsg":"ok"}' }])
    await sendText(webhookChannel(), '你好', fetch)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://oapi.dingtalk.com/robot/send?access_token=abc')
    const body = JSON.parse(calls[0]?.body ?? '{}') as { msgtype: string; text: { content: string } }
    expect(body.msgtype).toBe('text')
    expect(body.text.content).toBe('你好')
  })

  it('adds timestamp + sign to the URL when the webhook has a secret', async () => {
    const { fetch, calls } = stubFetch([{ body: '{"errcode":0,"errmsg":"ok"}' }])
    await sendText(webhookChannel({ secret: 'SECRET' }), 'x', fetch)
    const url = new URL(calls[0]?.url ?? '')
    expect(url.searchParams.get('timestamp')).toBeTruthy()
    expect(url.searchParams.get('sign')).toBeTruthy()
  })

  it('stream-mode robot (app) rejects outbound push sends', async () => {
    const { fetch } = stubFetch([])
    // Stream robots are receive-side; sendText must refuse to push.
    await expect(sendText(appChannel(), 'app msg', fetch)).rejects.toThrow(/stream-mode robot does not send/)
  })

  it('throws when the robot rejects the send', async () => {
    const { fetch } = stubFetch([{ body: '{"errcode":310000,"errmsg":"keywords not in content"}' }])
    await expect(sendText(webhookChannel(), 'x', fetch)).rejects.toThrow(/keywords not in content/)
  })

  it('throws on non-zero HTTP status', async () => {
    const { fetch } = stubFetch([{ ok: false, status: 403, body: 'forbidden' }])
    await expect(sendText(webhookChannel(), 'x', fetch)).rejects.toThrow(/HTTP 403/)
  })
})
