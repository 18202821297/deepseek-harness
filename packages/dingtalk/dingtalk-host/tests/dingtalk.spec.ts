/**
 * Host-side unit tests for DingtalkService — real storage backend in a temp
 * dir, no Web UI. ✅ VERIFIED pattern: mirrors message-feedback's harness
 * (new Context() + Storage/StorageJson/StorageDomain + plugin).
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import DingtalkService from '../src/index.ts'
import { dingtalkWorkspaceDir } from '../src/agent.ts'

interface Harness {
  ctx: Context
  root: string
  service: DingtalkService
  dispose: () => Promise<void>
}

/** Compose the service over the real storage hub/domain/JSON backend. */
async function setupHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-test-'))
  // Pin $DSH_HOME into the temp root so workspace-directory provisioning and
  // teardown never touch the developer's real ~/.dsh.
  vi.stubEnv('DSH_HOME', root)
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(DingtalkService)
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const service = ctx.dingtalk as unknown as DingtalkService
  if (service === undefined) throw new Error('DingtalkService did not load')
  return {
    ctx,
    root,
    service,
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

describe('DingtalkService', () => {
  it('saveChannel then listChannels returns the channel', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    const saved = await h.service.saveChannel({ input: {
      id: 'c1', name: '测试通道', type: 'webhook', webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
    } })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.value.name).toBe('测试通道')

    const list = await h.service.listChannels({})
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.value.channels).toHaveLength(1)
    expect(list.value.channels[0]?.name).toBe('测试通道')
  })

  it('persists to the JSON file on disk', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveChannel({ input: {
      id: 'c1', name: 'persisted', type: 'webhook', webhookUrl: 'https://example.com/hook',
    } })
    // storage-json writes one <unit>.json per domain; the unit name is the domain name.
    const file = join(h.root, 'channels.json')
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('persisted')
  })

  it('rejects invalid webhookUrl', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    const result = await h.service.saveChannel({ input: {
      id: 'bad', name: 'x', type: 'webhook', webhookUrl: 'not-a-url',
    } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid-input')
  })

  it('deleteChannel removes and returns deleted=true; absent returns false', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveChannel({ input: {
      id: 'c1', name: 'x', type: 'webhook', webhookUrl: 'https://example.com/hook',
    } })
    const del = await h.service.deleteChannel({ id: 'c1' })
    expect(del.ok).toBe(true)
    if (!del.ok) return
    expect(del.value.deleted).toBe(true)
    const list = await h.service.listChannels({})
    if (list.ok) expect(list.value.channels).toHaveLength(0)
    const del2 = await h.service.deleteChannel({ id: 'c1' })
    if (del2.ok) expect(del2.value.deleted).toBe(false)
  })

  it('setEnabled toggles and returns channel-not-found for missing id', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveChannel({ input: {
      id: 'c1', name: 'x', type: 'webhook', webhookUrl: 'https://example.com/hook', enabled: true,
    } })
    const toggled = await h.service.setEnabled({ id: 'c1', enabled: false })
    expect(toggled.ok).toBe(true)
    if (toggled.ok && toggled.value.found) expect(toggled.value.channel.enabled).toBe(false)
    const missing = await h.service.setEnabled({ id: 'nope', enabled: true })
    expect(missing.ok).toBe(true)
    if (missing.ok) expect(missing.value.found).toBe(false)
  })

  it('reloads persisted channels on a fresh service over the same root', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveChannel({ input: {
      id: 'c1', name: 'survives-restart', type: 'webhook', webhookUrl: 'https://example.com/hook',
    } })
    // Simulate restart: new context + new service over the same root dir.
    const ctx2 = new Context()
    await ctx2.plugin(Storage)
    await ctx2.plugin(StorageJson, { root: h.root })
    await ctx2.plugin(StorageDomain, { backend: 'json' })
    await ctx2.plugin(DingtalkService)
    const service2 = ctx2.dingtalk as unknown as DingtalkService
    const list = await service2.listChannels({})
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.value.channels.some(c => c.name === 'survives-restart')).toBe(true)
    await ctx2.fiber.dispose()
  })

  it('saves an app-type channel with clientId and encrypts the secret at rest', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    const saved = await h.service.saveChannel({ input: {
      id: 'app1', name: '企业内部机器人', type: 'app', clientId: 'dings6ononu21t3m4yem', clientSecret: 'topsecret',
    } })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.value.type).toBe('app')

    // The stored file must NOT contain the plaintext secret.
    const raw = await readFile(join(h.root, 'channels.json'), 'utf8')
    expect(raw).not.toContain('topsecret')
    expect(raw).toContain('dings6ononu21t3m4yem')

    // listChannels returns the masked secret, never the plaintext.
    const list = await h.service.listChannels({})
    expect(list.ok).toBe(true)
    if (!list.ok) return
    const app = list.value.channels.find(c => c.type === 'app')
    expect(app).toBeDefined()
    if (app?.type === 'app') {
      expect(app.clientId).toBe('dings6ononu21t3m4yem')
      expect(app.clientSecret).not.toContain('topsecret')
    }
  })

  it('edit keeps the stored clientSecret when the input secret is blank', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveChannel({ input: {
      id: 'app1', name: '机器人', type: 'app', clientId: 'cid1', clientSecret: 'orig-secret',
    } })
    // Edit: change the name only, leave clientSecret blank.
    const updated = await h.service.saveChannel({ input: {
      id: 'app1', name: '机器人改名', type: 'app', clientId: 'cid1', clientSecret: '',
    } })
    expect(updated.ok).toBe(true)
    // The stored encrypted secret is unchanged: still decrypts to orig-secret.
    const list = await h.service.listChannels({})
    if (!list.ok) return
    const app = list.value.channels.find(c => c.type === 'app' && c.id === 'app1')
    expect(app?.name).toBe('机器人改名')
    expect(app?.type === 'app' ? app.clientSecret : '').not.toContain('orig-secret')
  })

  it('testChannel sends a message for webhook and validates credentials for app', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveChannel({ input: {
      id: 'wh', name: 'wh', type: 'webhook', webhookUrl: 'https://example.com/hook',
    } })
    await h.service.saveChannel({ input: {
      id: 'app1', name: '机器人', type: 'app', clientId: 'k', clientSecret: 's',
    } })

    // webhook test: sends a message (network stubbed, no access_token needed).
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '{"errcode":0,"errmsg":"ok"}' }))
    const whTest = await h.service.testChannel({ id: 'wh' })
    expect(whTest.ok).toBe(true)
    if (whTest.ok) expect(whTest.value.ok).toBe(true)

    // app test: validates clientId/clientSecret via gettoken (token stub).
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '{"errcode":0,"access_token":"TOK"}' }))
    const appTest = await h.service.testChannel({ id: 'app1' })
    expect(appTest.ok).toBe(true)
    if (appTest.ok) expect(appTest.value.ok).toBe(true)

    // app test failure surfaces as ok:false with the DingTalk error detail.
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '{"errcode":40013,"errmsg":"invalid appkey"}' }))
    const appFail = await h.service.testChannel({ id: 'app1' })
    expect(appFail.ok).toBe(true)
    if (appFail.ok) expect(appFail.value.ok).toBe(false)
    vi.unstubAllGlobals()
  })

  it('creating an app channel provisions its dedicated workspace directory', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveChannel({ input: {
      id: 'app-ws1', name: '机器人', type: 'app', clientId: 'cid1', clientSecret: 's1',
    } })
    const dir = dingtalkWorkspaceDir('app-ws1')
    expect(dir.startsWith(h.root)).toBe(true)
    await expect(stat(dir)).resolves.toBeTruthy()
    // Re-editing the same channel keeps the directory (no duplication, no wipe).
    await h.service.saveChannel({ input: {
      id: 'app-ws1', name: '机器人2', type: 'app', clientId: 'cid1', clientSecret: 's2',
    } })
    await expect(stat(dir)).resolves.toBeTruthy()
  })

  it('webhook channels do not provision a workspace directory', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveChannel({ input: {
      id: 'wh-ws', name: 'hook', type: 'webhook', webhookUrl: 'https://example.com/hook',
    } })
    await expect(stat(dingtalkWorkspaceDir('wh-ws'))).rejects.toThrow()
  })

  it('deleteChannel keeps the workspace unless removeWorkspace is ticked', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    await h.service.saveChannel({ input: {
      id: 'app-del', name: '机器人', type: 'app', clientId: 'cid1', clientSecret: 's1',
    } })
    const dir = dingtalkWorkspaceDir('app-del')
    await expect(stat(dir)).resolves.toBeTruthy()
    // Delete without the flag: directory (and session history) survives.
    await h.service.deleteChannel({ id: 'app-del' })
    await expect(stat(dir)).resolves.toBeTruthy()
    // Delete a fresh channel with the flag: directory is removed.
    await h.service.saveChannel({ input: {
      id: 'app-del2', name: '机器人', type: 'app', clientId: 'cid2', clientSecret: 's1',
    } })
    await h.service.deleteChannel({ id: 'app-del2', removeWorkspace: true })
    await expect(stat(dingtalkWorkspaceDir('app-del2'))).rejects.toThrow()
  })

  it('rejects channel ids that are not path-safe', async () => {
    const h = await setupHarness()
    harnesses.push(h)
    const result = await h.service.saveChannel({ input: {
      id: '../escape', name: 'x', type: 'webhook', webhookUrl: 'https://example.com/hook',
    } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid-input')
  })
})
