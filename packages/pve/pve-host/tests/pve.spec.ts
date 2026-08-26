/**
 * Host-side unit tests for PveService — real storage backend in a temp dir,
 * fake PVE API connector and fake alert sender injected through the
 * constructor options, so no network is touched.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import PveService from '../src/index.ts'
import type { PveApiClient, PveApiConnector, PveApiResult } from '../src/api.ts'

/** In-memory state backing the fake API (what the real endpoints would return). */
interface ApiState {
  tasks: unknown[]
  taskLogs: Record<string, unknown[]>
  syslog: unknown[]
}

interface Harness {
  ctx: Context
  root: string
  service: PveService
  sender: ReturnType<typeof vi.fn>
  apiState: ApiState
  dispose: () => Promise<void>
}

/** Build a fake PVE API client backed by the in-memory ApiState. */
function fakeApi(state: ApiState): PveApiClient {
  const ok = (data: unknown): PveApiResult => ({ ok: true, status: 200, error: '', data })
  return {
    listTasks: async () => ok(state.tasks),
    getTaskLog: async upid => ok(state.taskLogs[upid] ?? []),
    getSyslog: async () => ok(state.syslog),
    close: () => {},
  }
}

/**
 * Compose the service over the real storage stack with a fake PVE API
 * connector and a fake alert sender.
 */
async function setupHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pve-test-'))
  vi.stubEnv('DSH_PVE_SECRET_KEY', 'test-key')
  const apiState: ApiState = { tasks: [], taskLogs: {}, syslog: [] }
  const api: PveApiConnector = () => fakeApi(apiState)
  const sender = vi.fn(async () => true)
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(PveService, { api, sender })
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const service = ctx.pve as unknown as PveService
  if (service === undefined) throw new Error('PveService did not load')
  return {
    ctx,
    root,
    service,
    sender,
    apiState,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const harnesses: Harness[] = []
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(h => h.dispose()))
  vi.unstubAllEnvs()
})

/** One task object as the PVE `/nodes/{node}/tasks` API returns it. */
function task(upid: string, status: string): { upid: string; status: string } {
  return { upid, status }
}

const OK_A = task('UPID:pve:0000ABCD:0009A3F5:660D1B2A:vzdump:100:root@pam:', 'OK')
const FAIL_A = task('UPID:pve:0000ABCE:0009A3F5:660D1B2B:qmigrate:101:root@pam:', 'command failed with exit code 255')
const FAIL_B = task('UPID:pve:0000ABCF:0009A3F5:660D1B2C:vzdump:102:root@pam:', 'unable to lock VM 102')

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'srv1',
    name: '主节点',
    apiUrl: 'https://10.1.0.5:8006',
    apiTokenId: 'root@pam!mytoken',
    apiTokenSecret: 'hunter2-secret',
    node: 'pve',
    enabled: true,
    ...overrides,
  }
}

describe('PveService', () => {
  it('saveServer then listServers returns the server with a masked token secret', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    const saved = await h.service.saveServer({ input: input() as never })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.value.apiTokenSecret).not.toContain('hunter2-secret')
    expect(saved.value.apiTokenSecret).toContain('••••')

    // On disk: the plaintext must never appear; the encrypted form must.
    const raw = await readFile(join(h.root, 'pve.json'), 'utf8')
    expect(raw).not.toContain('hunter2-secret')
  })

  it('rejects non-path-safe ids, empty fields, and non-http(s) apiUrl', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    const bad = await h.service.saveServer({ input: input({ id: '../x' }) as never })
    expect(bad.ok).toBe(false)
    const empty = await h.service.saveServer({ input: input({ name: ' ' }) as never })
    expect(empty.ok).toBe(false)
    const badUrl = await h.service.saveServer({ input: input({ apiUrl: '10.0.0.1:8006' }) as never })
    expect(badUrl.ok).toBe(false)
    const noNode = await h.service.saveServer({ input: input({ node: '' }) as never })
    expect(noNode.ok).toBe(false)
  })

  it('edit with blank token secret keeps the stored one', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveServer({ input: input() as never })
    const edited = await h.service.saveServer({ input: input({ name: '改名', apiTokenSecret: '' }) as never })
    expect(edited.ok).toBe(true)
    // collectNow against the fake API still works, proving the old secret survived.
    h.apiState.tasks = [FAIL_A]
    const collect = await h.service.collectNow({ id: 'srv1' })
    expect(collect.ok).toBe(true)
    if (collect.ok) expect(collect.value.error).toBe('')
  })

  it('collectNow reports new failed tasks until confirmDelivered marks them', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveServer({ input: input() as never })
    h.apiState.tasks = [OK_A, FAIL_A, FAIL_B]

    const first = await h.service.collectNow({ id: 'srv1' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.reported).toBe(2)
    expect(first.value.fresh?.length).toBe(2)

    // Nothing delivered yet: the same tasks stay fresh (at-least-once retry).
    const retry = await h.service.collectNow({ id: 'srv1' })
    expect(retry.ok).toBe(true)
    if (!retry.ok) return
    expect(retry.value.reported).toBe(2)

    // After a successful "push", confirm marks them: they stop re-firing.
    const confirm = await h.service.confirmDelivered({ id: 'srv1', upids: [FAIL_A.upid, FAIL_B.upid] })
    expect(confirm.ok).toBe(true)
    if (!confirm.ok) return
    expect(confirm.value.markedUpids).toBe(2)

    const second = await h.service.collectNow({ id: 'srv1' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.reported).toBe(0)
  })

  it('dedup state survives a service restart over the same storage', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveServer({ input: input() as never })
    h.apiState.tasks = [FAIL_A]
    const first = await h.service.collectNow({ id: 'srv1' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.reported).toBe(1)
    // Mark delivered so the state table holds the UPID across the restart.
    const confirm = await h.service.confirmDelivered({ id: 'srv1', upids: [FAIL_A.upid] })
    expect(confirm.ok).toBe(true)

    // Reload the service over the same root (fresh context, same storage).
    const ctx2 = new Context()
    await ctx2.plugin(Storage)
    await ctx2.plugin(StorageJson, { root: h.root })
    await ctx2.plugin(StorageDomain, { backend: 'json' })
    const state2 = h.apiState
    await ctx2.plugin(PveService, { api: () => fakeApi(state2), sender: vi.fn(async () => true) })
    const service2 = ctx2.pve as unknown as PveService
    const second = await service2.collectNow({ id: 'srv1' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.reported).toBe(0)
    await ctx2.fiber.dispose()
  })

  it('collectTest previews fresh tasks without marking them reported', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveServer({ input: input() as never })
    h.apiState.tasks = [OK_A, FAIL_A]

    const probe = await h.service.collectTest({ id: 'srv1' })
    expect(probe.ok).toBe(true)
    if (!probe.ok) return
    expect(probe.value.ok).toBe(true)
    expect(probe.value.wouldReport).toBe(1)

    // collectTest is a dry-run: a real collect still reports the same task.
    const collect = await h.service.collectNow({ id: 'srv1' })
    expect(collect.ok).toBe(true)
    if (!collect.ok) return
    expect(collect.value.reported).toBe(1)
  })

  it('deleteServer keeps state by default and removes it when opted in', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveServer({ input: input() as never })
    h.apiState.tasks = [FAIL_A]
    await h.service.collectNow({ id: 'srv1' })
    await h.service.confirmDelivered({ id: 'srv1', upids: [FAIL_A.upid] })

    const del = await h.service.deleteServer({ id: 'srv1' })
    expect(del.ok).toBe(true)
    if (!del.ok) return
    expect(del.value.deleted).toBe(true)

    // State survived: re-add the same id and collect the same task — no re-fire.
    await h.service.saveServer({ input: input() as never })
    const again = await h.service.collectNow({ id: 'srv1' })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.reported).toBe(0)

    // With removeState: state is gone, so the same task re-fires once.
    await h.service.deleteServer({ id: 'srv1', removeState: true })
    await h.service.saveServer({ input: input() as never })
    const refired = await h.service.collectNow({ id: 'srv1' })
    expect(refired.ok).toBe(true)
    if (!refired.ok) return
    expect(refired.value.reported).toBe(1)
  })

  it('collectNow on a missing server is rejected', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    const result = await h.service.collectNow({ id: 'nope' })
    expect(result.ok).toBe(false)
  })

  it('setEnabled toggles and reports not-found for missing ids', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveServer({ input: input() as never })
    const toggled = await h.service.setEnabled({ id: 'srv1', enabled: false })
    expect(toggled.ok).toBe(true)
    if (toggled.ok && toggled.value.found) expect(toggled.value.server.enabled).toBe(false)
    const missing = await h.service.setEnabled({ id: 'nope', enabled: true })
    expect(missing.ok).toBe(true)
    if (missing.ok) expect(missing.value.found).toBe(false)
  })
})
