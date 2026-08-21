// @vitest-environment jsdom
/**
 * PveConfig (PVE server collector settings tab) full user-flow tests.
 *
 * The add/edit form lives in a Modal (opens from the panel header).
 * Server lists (with collect/toggle/delete) stay inline per row.
 * Tests add servers through the modal, verify save carries the right
 * fields, edit pre-fills the modal to the same id, delete goes through
 * a confirm dialog with an optional removeState checkbox, and collect
 * shows the result count.
 *
 * Remote verbs are mocked with an in-memory store mirroring Host semantics.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { PveServer, PveServerInput } from '@deepseek-ai/dsh-pve-host/types'
import type { DingtalkChannel } from '@deepseek-ai/dsh-dingtalk-host/types'
import { PveConfig } from '../src/client/PveConfig.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

function server(overrides: Partial<PveServer> = {}): PveServer {
  return {
    id: 'srv1', name: '测试服务器', host: '10.0.0.1', port: 22, username: 'root',
    password: '••••', remark: '', enabled: true, pushEnabled: true, channelIds: [],
    aiEnabled: false, aiPrompt: '', aiModel: null,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as PveServer
}

function channel(overrides: Partial<DingtalkChannel> = {}): DingtalkChannel {
  return {
    id: 'c1', name: '运维群', type: 'webhook', webhookUrl: 'https://example.com/hook',
    secret: '', enabled: true, createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z', ...overrides,
  } as DingtalkChannel
}

/** Mount PveConfig with remote verbs backed by an in-memory store. */
function mount(initial: PveServer[] = [], channels: DingtalkChannel[] = []) {
  const store = new Map<string, PveServer>(initial.map(s => [s.id, s]))
  const listServers = vi.fn(async () => ({
    ok: true as const,
    value: { ok: true as const, value: { servers: [...store.values()] } },
  }))
  const saveServer = vi.fn(async ({ input }: { input: PveServerInput }) => {
    const now = '2025-01-01T00:00:00.000Z'
    const existing = store.get(input.id)
    const saved: PveServer = {
      id: input.id, name: input.name, host: input.host, port: input.port,
      username: input.username, password: '••••',
      remark: input.remark ?? existing?.remark ?? '',
      enabled: input.enabled ?? existing?.enabled ?? true,
      pushEnabled: input.pushEnabled ?? existing?.pushEnabled ?? true,
      channelIds: [...(input.channelIds ?? existing?.channelIds ?? [])],
      aiEnabled: input.aiEnabled ?? existing?.aiEnabled ?? false,
      aiPrompt: input.aiPrompt ?? existing?.aiPrompt ?? '',
      aiModel: input.aiModel ?? existing?.aiModel ?? null,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    } as PveServer
    store.set(input.id, saved)
    return { ok: true as const, value: { ok: true as const, value: saved } }
  })
  const deleteServer = vi.fn(async ({ id }: { id: string; removeState?: boolean }) => {
    const deleted = store.delete(id)
    return { ok: true as const, value: { ok: true as const, value: { deleted } } }
  })
  const setEnabled = vi.fn(async ({ id, enabled }: { id: string; enabled: boolean }) => {
    const cur = store.get(id)
    if (!cur) return { ok: true as const, value: { ok: true as const, value: { found: false } } }
    const next = { ...cur, enabled }
    store.set(id, next)
    return { ok: true as const, value: { ok: true as const, value: { found: true, server: next } } }
  })
  const setPushEnabled = vi.fn(async ({ id, pushEnabled }: { id: string; pushEnabled: boolean }) => {
    const cur = store.get(id)
    if (!cur) return { ok: true as const, value: { ok: true as const, value: { found: false } } }
    const next = { ...cur, pushEnabled }
    store.set(id, next)
    return { ok: true as const, value: { ok: true as const, value: { found: true, server: next } } }
  })
  const collectNow = vi.fn(async () => ({
    ok: true as const,
    value: { ok: true as const, value: { reported: 1, skipped: 0, error: '' } },
  }))
  const collectTest = vi.fn(async () => ({
    ok: true as const,
    value: {
      ok: true as const,
      value: {
        ok: true, error: '', lines: 5, entries: 3, fresh: [], wouldReport: 0, pushEnabled: true,
      },
    },
  }))
  const listChannels = vi.fn(async () => ({
    ok: true as const,
    value: { ok: true as const, value: { channels } },
  }))
  const listModels = vi.fn(async () => ({
    ok: true as const,
    value: { ok: true as const, value: { groups: [{ provider: 'deepseek', models: ['deepseek-chat'] }] } },
  }))
  const props = {
    t, listServers, saveServer, deleteServer, setEnabled, setPushEnabled,
    collectNow, collectTest, listChannels, listModels,
  } as unknown as Parameters<typeof PveConfig>[0]
  return {
    ...render(<PveConfig {...props} />),
    store, listServers, saveServer, deleteServer, setEnabled, setPushEnabled, collectNow, collectTest, listChannels, listModels,
  }
}

/** Open the add modal and fill in name + host, then submit. */
async function addServer(r: ReturnType<typeof mount>, name: string, host: string) {
  fireEvent.click(screen.getByText('添加服务器'))
  const dialog = await screen.findByRole('dialog')
  const d = within(dialog)
  fireEvent.change(d.getByPlaceholderText('服务器名称'), { target: { value: name } })
  fireEvent.change(d.getByPlaceholderText('10.0.0.1'), { target: { value: host } })
  // The footer button shares its label with the panel-header button; pick the
  // last match (footer always renders after the header in DOM order).
  fireEvent.click(d.getAllByText('添加服务器').at(-1)!)
  await waitFor(() => expect(r.saveServer).toHaveBeenCalled())
}

describe('PveConfig server flow', () => {
  it('lists initial servers on mount', async () => {
    const r = mount([server({ name: 'prod-01' })])
    await waitFor(() => expect(screen.getByText('prod-01')).toBeTruthy())
    expect(r.listServers).toHaveBeenCalled()
  })

  it('adds a server through the modal; save carries name and host', async () => {
    const r = mount()
    await addServer(r, 'web-01', '192.168.1.10')
    expect(r.saveServer).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ name: 'web-01', host: '192.168.1.10' }),
    }))
    expect(r.store.size).toBe(1)
  })

  it('validates: name and host are required (empty name shows error)', async () => {
    const r = mount()
    fireEvent.click(screen.getByText('添加服务器'))
    const dialog = await screen.findByRole('dialog')
    const d = within(dialog)
    // Submit without filling anything.
    fireEvent.click(d.getAllByText('添加服务器').at(-1)!)
    await waitFor(() => expect(screen.getByText('name and host are required')).toBeTruthy())
    expect(r.saveServer).not.toHaveBeenCalled()
  })

  it('edits a server: modal pre-fills to the SAME id, save updates it', async () => {
    const r = mount([server({ id: 'srv1', name: '旧名' })])
    await waitFor(() => expect(screen.getByText('旧名')).toBeTruthy())
    fireEvent.click(screen.getByText('编辑'))
    const dialog = await screen.findByRole('dialog')
    const d = within(dialog)
    await waitFor(() => expect((d.getByPlaceholderText('服务器名称') as HTMLInputElement).value).toBe('旧名'))
    expect((d.getByPlaceholderText('10.0.0.1') as HTMLInputElement).value).toBe('10.0.0.1')
    // The footer button for edit mode says "保存更新".
    fireEvent.change(d.getByPlaceholderText('服务器名称'), { target: { value: '新名' } })
    fireEvent.click(d.getByText('保存更新'))
    await waitFor(() => expect(r.saveServer).toHaveBeenCalled())
    expect(r.saveServer).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ id: 'srv1', name: '新名' }),
    }))
    expect(r.store.size).toBe(1)
  })

  it('cancel in the modal closes it without saving', async () => {
    const r = mount([server({ id: 'srv1', name: '原名' })])
    await waitFor(() => expect(screen.getByText('原名')).toBeTruthy())
    fireEvent.click(screen.getByText('编辑'))
    const dialog = await screen.findByRole('dialog')
    const d = within(dialog)
    await waitFor(() => expect((d.getByPlaceholderText('服务器名称') as HTMLInputElement).value).toBe('原名'))
    fireEvent.click(d.getByText('取消'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(r.saveServer).not.toHaveBeenCalled()
  })

  it('delete opens a confirm dialog with removeState checkbox (unticked default)', async () => {
    const r = mount([server({ id: 'srv1', name: '测试服务器' })])
    await waitFor(() => expect(screen.getByText('测试服务器')).toBeTruthy())
    fireEvent.click(screen.getByText('删除'))
    const dialog = await screen.findByRole('dialog')
    const d = within(dialog)
    // removeState checkbox exists and is unticked.
    const box = d.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(d.getByText('删除'))
    await waitFor(() => expect(r.deleteServer).toHaveBeenCalledWith({ id: 'srv1', removeState: false }))
    expect(r.store.size).toBe(0)
  })

  it('delete with removeState ticked sends removeState: true', async () => {
    const r = mount([server({ id: 'srv1', name: '测试服务器' })])
    await waitFor(() => expect(screen.getByText('测试服务器')).toBeTruthy())
    fireEvent.click(screen.getByText('删除'))
    const dialog = await screen.findByRole('dialog')
    const d = within(dialog)
    fireEvent.click(d.getByRole('checkbox'))
    fireEvent.click(d.getByText('删除'))
    await waitFor(() => expect(r.deleteServer).toHaveBeenCalledWith({ id: 'srv1', removeState: true }))
  })

  it('toggles a server enabled flag', async () => {
    const r = mount([server({ id: 'srv1', enabled: true })])
    await waitFor(() => expect(screen.getByText('测试服务器')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('启用/停用'))
    await waitFor(() => expect(r.setEnabled).toHaveBeenCalledWith({ id: 'srv1', enabled: false }))
  })

  it('collect now shows the reported count', async () => {
    const r = mount([server({ id: 'srv1', name: '测试服务器' })])
    await waitFor(() => expect(screen.getByText('测试服务器')).toBeTruthy())
    fireEvent.click(screen.getByText('立即采集'))
    await waitFor(() => expect(r.collectNow).toHaveBeenCalledWith({ id: 'srv1' }))
    await waitFor(() => expect(screen.getByText(/采集完成/)).toBeTruthy())
  })

  it('shows available channels as multi-select checkboxes', async () => {
    const r = mount([server({ id: 'srv1', name: '测试服务器' })], [channel({ id: 'c1', name: '运维群' })])
    await waitFor(() => expect(screen.getByText('测试服务器')).toBeTruthy())
    fireEvent.click(screen.getByText('编辑'))
    const dialog = await screen.findByRole('dialog')
    const d = within(dialog)
    // Channel checkbox is visible and unchecked (server has no channels).
    const box = d.getByLabelText('运维群') as HTMLInputElement
    expect(box).toBeTruthy()
    expect(box.checked).toBe(false)
    // Tick it, save, and verify the save carries the channel.
    fireEvent.click(box)
    fireEvent.click(d.getByText('保存更新'))
    await waitFor(() => expect(r.saveServer).toHaveBeenCalled())
    expect(r.saveServer).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ channelIds: ['c1'] }),
    }))
  })

  it('shows channel-none hint when no channels available', async () => {
    mount([server({ id: 'srv1', name: '测试服务器' })], [])
    await waitFor(() => expect(screen.getByText('测试服务器')).toBeTruthy())
    fireEvent.click(screen.getByText('编辑'))
    const dialog = await screen.findByRole('dialog')
    const d = within(dialog)
    await waitFor(() => expect(d.getByText(/暂无可用的钉钉通道/)).toBeTruthy())
  })
})
