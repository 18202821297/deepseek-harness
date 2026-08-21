// @vitest-environment jsdom
/**
 * ImChannels (DingTalk channel settings tab) full user-flow tests.
 *
 * The add/edit form lives in a Modal (opens from each section's header).
 * Channel lists (with send/test/toggle/delete) stay inline per section.
 * Tests add channels through the modal, confirm each list shows only its
 * own type, verify auto id generation (never overwrites), and send/test.
 *
 * Remote verbs are mocked with an in-memory store mirroring Host semantics.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  DingtalkChannel,
  DingtalkChannelInput,
} from '@deepseek-ai/dsh-dingtalk-host/types'
import { ImChannels } from '../src/client/ImChannels.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

function channel(overrides: Partial<Omit<DingtalkChannel, 'type'>> & { type?: 'webhook' } = {}): DingtalkChannel {
  return {
    id: 'c1', name: '测试通道', type: 'webhook', webhookUrl: 'https://example.com/hook', secret: '',
    enabled: true, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as DingtalkChannel
}

function appChannel(overrides: Partial<Omit<DingtalkChannel, 'type'>> & { type?: 'app' } = {}): DingtalkChannel {
  return {
    id: 'app1', name: '企业内部机器人', type: 'app', clientId: 'dings6ononu21t3m4yem', clientSecret: '••••', agentPreset: 'standard',
    enabled: true, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as DingtalkChannel
}

/** Mount ImChannels with remote verbs backed by an in-memory store. */
function mount(initial: DingtalkChannel[] = []) {
  const store = new Map<string, DingtalkChannel>(initial.map(c => [c.id, c]))
  const listChannels = vi.fn(async () => ({
    ok: true as const,
    value: { ok: true as const, value: { channels: [...store.values()] } },
  }))
  const saveChannel = vi.fn(async ({ input }: { input: DingtalkChannelInput }) => {
    const now = '2025-01-01T00:00:00.000Z'
    const base = { id: input.id, name: input.name, enabled: input.enabled ?? true, createdAt: now, updatedAt: now }
    const saved: DingtalkChannel = input.type === 'webhook'
      ? { ...base, type: 'webhook', webhookUrl: input.webhookUrl, secret: input.secret ?? '' }
      : { ...base, type: 'app', clientId: input.clientId, clientSecret: input.clientSecret ?? '', agentPreset: input.agentPreset ?? 'standard' }
    store.set(input.id, saved)
    return { ok: true as const, value: { ok: true as const, value: saved } }
  })
  const deleteChannel = vi.fn(async ({ id }: { id: string }) => {
    const deleted = store.delete(id)
    return { ok: true as const, value: { ok: true as const, value: { deleted } } }
  })
  const setEnabled = vi.fn(async ({ id, enabled }: { id: string; enabled: boolean }) => {
    const cur = store.get(id)
    if (!cur) return { ok: true as const, value: { ok: true as const, value: { found: false } } }
    const next = { ...cur, enabled }
    store.set(id, next)
    return { ok: true as const, value: { ok: true as const, value: { found: true, channel: next } } }
  })
  const sendText = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, value: { sent: true } } }))
  const testChannel = vi.fn(async () => ({ ok: true as const, value: { ok: true as const, value: { ok: true, detail: 'sent: test' } } }))
  const props = { t, listChannels, saveChannel, deleteChannel, setEnabled, sendText, testChannel } as unknown as
    Parameters<typeof ImChannels>[0]
  return {
    ...render(<ImChannels {...props} />),
    store, listChannels, saveChannel, deleteChannel, setEnabled, sendText, testChannel,
  }
}

/** Open the add modal for the webhook section and submit the form. */
async function addWebhook(rendered: ReturnType<typeof mount>, name: string) {
  const section = screen.getByText('钉钉 Webhook 配置').closest('section') as HTMLElement
  fireEvent.click(within(section).getByText('添加通道'))
  const dialog = await screen.findByRole('dialog')
  const d = within(dialog)
  fireEvent.change(d.getByPlaceholderText('通道名称'), { target: { value: name } })
  fireEvent.change(d.getByPlaceholderText('Webhook URL'), { target: { value: `https://${name}.com/hook` } })
  fireEvent.click(d.getByText('添加通道'))
  await waitFor(() => expect(rendered.saveChannel).toHaveBeenCalled())
}

/** Open the add modal for the robot section and submit the form. */
async function addApp(rendered: ReturnType<typeof mount>, name: string) {
  const section = screen.getByText('钉钉机器人配置').closest('section') as HTMLElement
  fireEvent.click(within(section).getByText('添加通道'))
  const dialog = await screen.findByRole('dialog')
  const d = within(dialog)
  fireEvent.change(d.getByPlaceholderText('通道名称'), { target: { value: name } })
  fireEvent.change(d.getByPlaceholderText('Client ID'), { target: { value: `k-${name}` } })
  fireEvent.change(d.getByPlaceholderText('Client Secret（留空不修改）'), { target: { value: `s-${name}` } })
  fireEvent.click(d.getByText('添加通道'))
  await waitFor(() => expect(rendered.saveChannel).toHaveBeenCalled())
}

describe('ImChannels two-section flow', () => {
  it('webhook section lists only webhook channels; robot section only robot channels', async () => {
    const r = mount([channel({ name: 'wh-existing' }), appChannel({ name: 'app-existing' })])
    await waitFor(() => expect(screen.getByText('wh-existing')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('app-existing')).toBeTruthy())

    const whSection = screen.getByText('钉钉 Webhook 配置').closest('section') as HTMLElement
    const appSection = screen.getByText('钉钉机器人配置').closest('section') as HTMLElement
    expect(within(whSection).getByText('wh-existing')).toBeTruthy()
    expect(within(appSection).getByText('app-existing')).toBeTruthy()
    // Neither leaks into the other section.
    expect(within(whSection).queryByText('app-existing')).toBeNull()
    expect(within(appSection).queryByText('wh-existing')).toBeNull()
    expect(r.store.size).toBe(2)
  })

  it('adds a webhook and a robot; both survive side by side', async () => {
    const r = mount()
    await addWebhook(r, 'wh1')
    await addApp(r, 'robot1')
    expect(r.store.size).toBe(2)
    await waitFor(() => expect(screen.getByText('wh1')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('robot1')).toBeTruthy())
  })

  it('auto-generates a distinct id for every channel (never overwrites)', async () => {
    const r = mount()
    await addWebhook(r, 'wh1')
    await addApp(r, 'robot1')
    const ids = [...r.store.keys()]
    expect(ids.length).toBe(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('adds two app channels consecutively, both as app type', async () => {
    const r = mount()
    await addApp(r, 'a1')
    await addApp(r, 'a2')
    expect(r.store.size).toBe(2)
    expect([...r.store.values()].map(c => c.type)).toEqual(['app', 'app'])
  })

  it('test-sends and typed-sends through a webhook channel', async () => {
    const r = mount([channel()])
    await waitFor(() => expect(screen.getByText('测试通道')).toBeTruthy())
    const whSection = screen.getByText('钉钉 Webhook 配置').closest('section') as HTMLElement
    fireEvent.click(within(whSection).getByText('测试发送'))
    await waitFor(() => expect(r.testChannel).toHaveBeenCalledWith({ id: 'c1' }))
    await waitFor(() => expect(screen.getByText(/sent: test/)).toBeTruthy())

    fireEvent.change(within(whSection).getByPlaceholderText('输入消息内容…'), { target: { value: 'hello' } })
    fireEvent.click(within(whSection).getByText('发送'))
    await waitFor(() => expect(r.sendText).toHaveBeenCalledWith({ id: 'c1', content: 'hello' }))
  })

  it('deletes and toggles a channel (delete goes through the confirm dialog)', async () => {
    const r = mount([channel()])
    await waitFor(() => expect(screen.getByText('测试通道')).toBeTruthy())
    const whSection = screen.getByText('钉钉 Webhook 配置').closest('section') as HTMLElement
    fireEvent.click(within(whSection).getByLabelText('启用/停用'))
    await waitFor(() => expect(r.setEnabled).toHaveBeenCalledWith({ id: 'c1', enabled: false }))
    // Clicking Delete opens a confirmation dialog; nothing is deleted yet.
    fireEvent.click(within(whSection).getByText('删除'))
    const dialog = await screen.findByRole('dialog')
    // Webhook channels have no workspace, so no remove-workspace checkbox shows.
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    fireEvent.click(within(dialog).getByText('删除'))
    await waitFor(() => expect(r.deleteChannel).toHaveBeenCalledWith({ id: 'c1' }))
    expect(r.store.size).toBe(0)
  })

  it('deleting an app channel offers the remove-workspace checkbox (unticked default)', async () => {
    const r = mount([appChannel({ id: 'app1', name: '机器人' })])
    await waitFor(() => expect(screen.getByText('机器人')).toBeTruthy())
    const appSection = screen.getByText('钉钉机器人配置').closest('section') as HTMLElement
    fireEvent.click(within(appSection).getByText('删除'))
    const dialog = await screen.findByRole('dialog')
    // Unticked by default: delete keeps the workspace directory.
    const box = within(dialog).getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(within(dialog).getByText('删除'))
    await waitFor(() => expect(r.deleteChannel).toHaveBeenCalledWith({ id: 'app1', removeWorkspace: false }))
  })

  it('deleting an app channel with the box ticked sends removeWorkspace: true', async () => {
    const r = mount([appChannel({ id: 'app1', name: '机器人' })])
    await waitFor(() => expect(screen.getByText('机器人')).toBeTruthy())
    const appSection = screen.getByText('钉钉机器人配置').closest('section') as HTMLElement
    fireEvent.click(within(appSection).getByText('删除'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByText('删除'))
    await waitFor(() => expect(r.deleteChannel).toHaveBeenCalledWith({ id: 'app1', removeWorkspace: true }))
  })

  it('edits a webhook channel: backfills the modal, saves to the SAME id', async () => {
    const r = mount([channel({ id: 'c1', name: '旧名' })])
    await waitFor(() => expect(screen.getByText('旧名')).toBeTruthy())
    const whSection = screen.getByText('钉钉 Webhook 配置').closest('section') as HTMLElement
    const s = within(whSection)

    // Click Edit in the list row: the modal opens pre-filled with the channel's values.
    fireEvent.click(s.getByText('编辑'))
    const dialog = await screen.findByRole('dialog')
    const d = within(dialog)
    await waitFor(() => expect((d.getByPlaceholderText('通道名称') as HTMLInputElement).value).toBe('旧名'))
    expect((d.getByPlaceholderText('Webhook URL') as HTMLInputElement).value).toBe('https://example.com/hook')

    // Change the name and save from the modal footer.
    fireEvent.change(d.getByPlaceholderText('通道名称'), { target: { value: '新名' } })
    fireEvent.click(d.getByText('保存更新'))
    await waitFor(() => expect(r.saveChannel).toHaveBeenCalled())
    // Must update the SAME id (not create a new channel) and carry the new name.
    expect(r.saveChannel).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ id: 'c1', name: '新名', type: 'webhook' }),
    }))
    expect(r.store.size).toBe(1)
    expect(r.store.get('c1')?.name).toBe('新名')
  })

  it('cancel in the modal closes it without saving', async () => {
    const r = mount([channel({ id: 'c1', name: '原名' })])
    await waitFor(() => expect(screen.getByText('原名')).toBeTruthy())
    const whSection = screen.getByText('钉钉 Webhook 配置').closest('section') as HTMLElement
    const s = within(whSection)
    fireEvent.click(s.getByText('编辑'))
    const dialog = await screen.findByRole('dialog')
    const d = within(dialog)
    await waitFor(() => expect((d.getByPlaceholderText('通道名称') as HTMLInputElement).value).toBe('原名'))
    fireEvent.click(d.getByText('取消'))
    // Modal closes and no save happened.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(r.saveChannel).not.toHaveBeenCalled()
  })
})
