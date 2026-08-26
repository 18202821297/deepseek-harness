/**
 * PVE REST API client for the collector. Talks to the node's own API
 * (`https://<host>:8006/api2/json`) with a stateless API token
 * (`Authorization: PVEAPIToken=<user@realm>!<tokenid>=<secret>`), so there is
 * no ticket / CSRF dance and no expiry to refresh. Self-signed certs are
 * accepted (typical for a fresh PVE install). The connector is injectable so
 * unit tests can fake the transport without any network.
 * @module @deepseek-ai/dsh-pve-host/src/api
 */

import https from 'node:https'

/** Connection parameters for one server. */
export interface PveApiTarget {
  /** PVE API base URL, e.g. `https://10.0.0.1:8006`. */
  readonly apiUrl: string
  /** API token id, e.g. `root@pam!mytoken`. */
  readonly tokenId: string
  /** API token secret (plaintext, decrypted from storage). */
  readonly tokenSecret: string
  /** Node name, e.g. `pve`. */
  readonly node: string
}

/** Result of one API call. */
export interface PveApiResult {
  ok: boolean
  /** HTTP status (0 = transport error). */
  status: number
  /** Failure reason when `ok` is false, else empty. */
  error: string
  /** The parsed `data` field of the PVE response when ok. */
  data: unknown
  /** The response's `total` field (syslog), when present. */
  total?: number
}

/** Minimal client surface the collector needs. */
export interface PveApiClient {
  /** `GET /nodes/{node}/tasks?limit=N` — recent tasks, newest first. */
  listTasks(limit: number): Promise<PveApiResult>
  /** `GET /nodes/{node}/tasks/{upid}/log?limit=N` — one task's raw log lines. */
  getTaskLog(upid: string, limit: number): Promise<PveApiResult>
  /** `GET /nodes/{node}/syslog?limit=N[&start=S]` — node syslog lines (raw text). */
  getSyslog(limit: number, start?: number): Promise<PveApiResult>
  /** Close the underlying agent (idempotent). */
  close(): void
}

/** Factory signature the service uses to obtain a client. */
export type PveApiConnector = (target: PveApiTarget) => PveApiClient

/** Default timeout for one API call. */
const API_TIMEOUT_MS = 30_000

/**
 * The production connector: issues authenticated GETs over HTTPS, accepting
 * self-signed certificates (the common case for an internal PVE node).
 */
export const realPveApiConnector: PveApiConnector = (target) => {
  const base = target.apiUrl.replace(/\/+$/, '')
  const auth = `PVEAPIToken=${target.tokenId}=${target.tokenSecret}`
  const agent = new https.Agent({ rejectUnauthorized: false })

  const call = (path: string): Promise<PveApiResult> => new Promise((resolve) => {
    if (/[\r\n\u0000-\u001f\u007f-\uffff]/.test(auth)) {
      resolve({
        ok: false,
        status: 0,
        error: 'invalid API token: id/secret contains illegal characters (e.g. a pasted non-ASCII hyphen) — re-enter the token from the PVE UI',
        data: null,
      })
      return
    }
    let url: URL
    try {
      url = new URL(`/api2/json${path}`, base)
    } catch {
      resolve({ ok: false, status: 0, error: `invalid apiUrl '${target.apiUrl}' — check the server's API address setting`, data: null })
      return
    }
    const req = https.request(url, {
      method: 'GET',
      headers: { Authorization: auth },
      agent,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        const body = Buffer.concat(chunks).toString('utf8')
        if (status < 200 || status >= 300) {
          resolve({ ok: false, status, error: `HTTP ${status}: ${body.slice(0, 200)}`, data: null })
          return
        }
        try {
          const json = JSON.parse(body) as { data?: unknown; total?: number }
          resolve({
            ok: true,
            status,
            error: '',
            data: json.data ?? null,
            ...(typeof json.total === 'number' ? { total: json.total } : {}),
          })
        } catch {
          resolve({ ok: false, status, error: `invalid JSON response: ${body.slice(0, 200)}`, data: null })
        }
      })
    })
    req.on('error', (error: Error) => resolve({ ok: false, status: 0, error: `api request failed: ${error.message}`, data: null }))
    req.setTimeout(API_TIMEOUT_MS, () => { req.destroy(new Error('api request timeout')) })
    req.end()
  })

  const node = encodeURIComponent(target.node)
  return {
    listTasks(limit: number): Promise<PveApiResult> {
      return call(`/nodes/${node}/tasks?limit=${limit}`)
    },
    getTaskLog(upid: string, limit: number): Promise<PveApiResult> {
      return call(`/nodes/${node}/tasks/${encodeURIComponent(upid)}/log?limit=${limit}`)
    },
    getSyslog(limit: number, start?: number): Promise<PveApiResult> {
      // `start` is a 1-based line offset (the API returns lines from `start`,
      // oldest first), so passing `total - N` fetches the most recent N lines.
      return call(`/nodes/${node}/syslog?limit=${limit}${start !== undefined ? `&start=${start}` : ''}`)
    },
    close(): void {
      agent.destroy()
    },
  }
}
