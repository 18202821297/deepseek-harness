/**
 * Host-side unit tests for PveService — real storage backend in a temp dir,
 * fake SSH connector and fake alert sender injected through the constructor
 * options, so no network is touched.
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
import type { SshConnector, SshFileReader } from '../src/ssh.ts'

interface Harness {
  ctx: Context
  root: string
  service: PveService
  sender: ReturnType<typeof vi.fn>
  files: Map<string, string>
  dispose: () => Promise<void>
}

/**
 * Compose the service over the real storage stack with a fake SSH connector
 * reading from an in-memory file map, and a fake alert sender.
 */
async function setupHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pve-test-'))
  vi.stubEnv('DSH_PVE_SECRET_KEY', 'test-key')
  const files = new Map<string, string>()
  const reader: SshFileReader = {
    readFile: async (path) => {
      const content = files.get(path)
      return content === undefined
        ? { ok: false, error: `no such file: ${path}`, content: '' }
        : { ok: true, error: '', content }
    },
    close: () => {},
  }
  const ssh: SshConnector = async () => reader
  const sender = vi.fn(async () => true)
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(PveService, { ssh, sender })
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
    files,
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

const OK_LINE = 'UPID:pve:0000ABCD:0009A3F5:660D1B2A:vzdump:100:root@pam:\tbackup vm 100\tOK'
const FAIL_A = 'UPID:pve:0000ABCE:0009A3F5:660D1B2B:qmigrate:101:root@pam:\tmigrate failed\tcommand failed with exit code 255'
const FAIL_B = 'UPID:pve:0000ABCF:0009A3F5:660D1B2C:vzdump:102:root@pam:\tjson tail\tunable to lock VM 102'
const INDEX = '/var/log/pve/tasks/index'
const INDEX_1 = '/var/log/pve/tasks/index.1'

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'srv1',
    name: '主节点',
    host: '10.1.0.5',
    port: 22,
    username: 'root',
    password: 'hunter2',
    enabled: true,
    channelIds: ['ch-dingtalk-1'],
    ...overrides,
  }
}

describe('PveService', () => {
  it('saveServer then listServers returns the server with a masked password', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    const saved = await h.service.saveServer({ input: input() as never })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.value.password).not.toContain('hunter2')
    expect(saved.value.password).toContain('••••')

    // On disk: the plaintext must never appear; the encrypted form must.
    const raw = await readFile(join(h.root, 'pve.json'), 'utf8')
    expect(raw).not.toContain('hunter2')
  })

  it('rejects non-path-safe ids and empty fields', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    const bad = await h.service.saveServer({ input: input({ id: '../x' }) as never })
    expect(bad.ok).toBe(false)
    const empty = await h.service.saveServer({ input: input({ name: ' ' }) as never })
    expect(empty.ok).toBe(false)
    const badPort = await h.service.saveServer({ input: input({ port: 0 }) as never })
    expect(badPort.ok).toBe(false)
  })

  it('edit with blank password keeps the stored one', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveServer({ input: input() as never })
    const edited = await h.service.saveServer({ input: input({ name: '改名', password: '' }) as never })
    expect(edited.ok).toBe(true)
    // collectNow against a fake SSH still works, proving the old password survived.
    h.files.set(INDEX, OK_LINE)
    const collect = await h.service.collectNow({ id: 'srv1' })
    expect(collect.ok).toBe(true)
    if (collect.ok) expect(collect.value.error).toBe('')
  })

  it('collectNow reports new failed tasks once, never twice', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveServer({ input: input() as never })
    h.files.set(INDEX, [OK_LINE, FAIL_A, FAIL_B].join('\n'))

    const first = await h.service.collectNow({ id: 'srv1' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.reported).toBe(2)

    // Same file again: nothing new, nothing re-sent.
    h.sender.mockClear()
    const second = await h.service.collectNow({ id: 'srv1' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.reported).toBe(0)
    expect(h.sender).not.toHaveBeenCalled()
  })

  it('sender failure does not cause a re-send on the next run', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveServer({ input: input() as never })
    h.files.set(INDEX, [FAIL_A].join('\n'))

    // First run: delivery fails.
    h.sender.mockImplementation(async () => false)
    const first = await h.service.collectNow({ id: 'srv1' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.reported).toBe(0)

    // Second run over the same file: the task is already marked; no re-send.
    h.sender.mockClear()
    h.sender.mockImplementation(async () => true)
    const second = await h.service.collectNow({ id: 'srv1' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.reported).toBe(0)
    expect(h.sender).not.toHaveBeenCalled()
  })

  it('rotation fallback re-reads index.1 and reports tasks that only lived there', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveServer({ input: input() as never })
    // Run 1: big index with FAIL_A near the tail.
    const bigIndex = [OK_LINE, FAIL_A, ...Array.from({ length: 50 }, (_, i) => `UPID:pve:0000F${i}:0009A3F5:660D1B2D:job:${i}:root@pam:\tstuff\tOK`)].join('\n')
    h.files.set(INDEX, bigIndex)
    const first = await h.service.collectNow({ id: 'srv1' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.reported).toBe(1)

    // Run 2: the index rotated (shrank); FAIL_A moved to index.1, FAIL_B is new.
    h.files.set(INDEX, [OK_LINE, FAIL_B].join('\n'))
    h.files.set(INDEX_1, [FAIL_A].join('\n'))
    h.sender.mockClear()
    const second = await h.service.collectNow({ id: 'srv1' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    // Only FAIL_B is new; FAIL_A was already reported (dedup holds across rotation).
    expect(second.value.reported).toBe(1)

    // Rotation gap: a task born between runs lives ONLY in index.1 (never
    // seen in any earlier run); it must still be picked up. FAIL_B was already
    // reported in run 2, so a fresh UPID is required here.
    const FAIL_C = 'UPID:pve:0000ABD0:0009A3F5:660D1B2E:vzdump:103:root@pam:\tgap task\tbackup failed'
    h.files.set(INDEX_1, [FAIL_C].join('\n'))
    h.files.set(INDEX, [OK_LINE].join('\n'))
    const stateFile = JSON.parse(await readFile(join(h.root, 'pve.json'), 'utf8')) as { tables: { task_state: Record<string, { processedUpids: string[]; lastIndexLines: number }> } }
    const state = stateFile.tables.task_state['srv1']!
    state.lastIndexLines = 500
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(h.root, 'pve.json'), JSON.stringify(stateFile))
    // Reload service over the mutated state (fresh context, same root).
    const ctx2 = new Context()
    await ctx2.plugin(Storage)
    await ctx2.plugin(StorageJson, { root: h.root })
    await ctx2.plugin(StorageDomain, { backend: 'json' })
    const sender2 = vi.fn(async () => true)
    const files2 = h.files
    await ctx2.plugin(PveService, {
      ssh: async () => ({
        readFile: async (path) => {
          const content = files2.get(path)
          return content === undefined ? { ok: false, error: 'missing', content: '' } : { ok: true, error: '', content }
        },
        close: () => {},
      }),
      sender: sender2,
    })
    const service2 = ctx2.pve as unknown as PveService
    const rotated = await service2.collectNow({ id: 'srv1' })
    expect(rotated.ok).toBe(true)
    if (!rotated.ok) return
    expect(rotated.value.reported).toBe(1)
    await ctx2.fiber.dispose()
  })

  it('deleteServer keeps state by default and removes it when opted in', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveServer({ input: input() as never })
    h.files.set(INDEX, [FAIL_A].join('\n'))
    await h.service.collectNow({ id: 'srv1' })

    const del = await h.service.deleteServer({ id: 'srv1' })
    expect(del.ok).toBe(true)
    if (!del.ok) return
    expect(del.value.deleted).toBe(true)

    // State survived: re-add the same id and collect the same file — no re-fire.
    await h.service.saveServer({ input: input() as never })
    h.sender.mockClear()
    await h.service.collectNow({ id: 'srv1' })
    expect(h.sender).not.toHaveBeenCalled()

    // With removeState: state is gone, so the same task re-fires once.
    await h.service.deleteServer({ id: 'srv1', removeState: true })
    await h.service.saveServer({ input: input() as never })
    h.sender.mockClear()
    await h.service.collectNow({ id: 'srv1' })
    expect(h.sender).toHaveBeenCalledTimes(1)
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
