import { useEffect, useState } from 'react'
import { Button, Input, StateDot, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { PRESET_IDS, PRESET_OPTIONS, type PresetId } from './presets.ts'
import type {
  DingtalkChannel,
  DingtalkChannelInput,
  DingtalkChannelType,
  DingtalkDeleteResult,
  DingtalkListResult,
  DingtalkSaveResult,
  DingtalkSendResult,
  DingtalkSetEnabledResult,
  DingtalkTestResult,
} from '@deepseek-ai/dsh-dingtalk-host/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import css from './ImChannels.module.css'

/** The Remote verbs injected into this component's props by the slot renderer. */
export interface DingtalkConfigProps {
  t: (key: string) => string
  listChannels: (input: {}) => Promise<RemoteResult<DingtalkListResult>>
  saveChannel: (input: { input: DingtalkChannelInput }) => Promise<RemoteResult<DingtalkSaveResult>>
  deleteChannel: (input: { id: string; removeWorkspace?: boolean }) => Promise<RemoteResult<DingtalkDeleteResult>>
  setEnabled: (input: { id: string; enabled: boolean }) => Promise<RemoteResult<DingtalkSetEnabledResult>>
  sendText: (input: { id: string; content: string }) => Promise<RemoteResult<DingtalkSendResult>>
  testChannel: (input: { id: string }) => Promise<RemoteResult<DingtalkTestResult>>
}

/** The verbs-only subset registered by the Host Remote (locale `t` is injected separately). */
export type ImChannelsInjected = Omit<DingtalkConfigProps, 't'>

/** One type's form fields (id is auto-generated on submit, never user-editable). */
interface TypeDraft {
  name: string
  webhookUrl: string
  secret: string
  clientId: string
  clientSecret: string
  agentPreset: string
  enabled: boolean
}

const emptyWebhook: TypeDraft = { name: '', webhookUrl: '', secret: '', clientId: '', clientSecret: '', agentPreset: 'minimal', enabled: true }
const emptyApp: TypeDraft = { name: '', webhookUrl: '', secret: '', clientId: '', clientSecret: '', agentPreset: 'minimal', enabled: true }

/** The shared field editor rendered inside the add/edit modal. */
function ChannelForm({
  type,
  draft,
  setDraft,
  t,
}: {
  type: DingtalkChannelType
  draft: TypeDraft
  setDraft: (patch: Partial<TypeDraft>) => void
  t: (key: string) => string
}) {
  return (
    <div className={css.form}>
      {type === 'webhook' ? (
        <div className={css.formRow}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('field.name')}</span>
            <Input
              aria-label={t('field.name')}
              placeholder={t('field.name')}
              value={draft.name}
              onChange={e => setDraft({ name: e.target.value })}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('field.webhook')}</span>
            <Input
              aria-label={t('field.webhook')}
              placeholder={t('field.webhook')}
              value={draft.webhookUrl}
              onChange={e => setDraft({ webhookUrl: e.target.value })}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('field.secret')}</span>
            <Input
              aria-label={t('field.secret')}
              placeholder={t('field.secret')}
              value={draft.secret}
              onChange={e => setDraft({ secret: e.target.value })}
            />
          </label>
        </div>
      ) : (
        <>
          <div className={css.formRow}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('field.name')}</span>
              <Input
                aria-label={t('field.name')}
                placeholder={t('field.name')}
                value={draft.name}
                onChange={e => setDraft({ name: e.target.value })}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('field.clientId')}</span>
              <Input
                aria-label={t('field.clientId')}
                placeholder={t('field.clientId')}
                value={draft.clientId}
                onChange={e => setDraft({ clientId: e.target.value })}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('field.clientSecret')}</span>
              <Input
                aria-label={t('field.clientSecret')}
                placeholder={t('field.clientSecret')}
                value={draft.clientSecret}
                onChange={e => setDraft({ clientSecret: e.target.value })}
              />
            </label>
          </div>
          <div className={css.presetField}>
            <span className={css.fieldLabel}>{t('field.agentPreset')}</span>
            <div className={css.presetGroup}>
              {PRESET_OPTIONS.map((opt) => {
                const checked = draft.agentPreset === opt.id
                return (
                  <label
                    key={opt.id}
                    className={`${css.presetCard} ${checked ? css.presetCardActive : ''}`}
                  >
                    <input
                      type="radio"
                      name="agentPreset"
                      value={opt.id}
                      checked={checked}
                      onChange={() => setDraft({ agentPreset: opt.id })}
                    />
                    <div className={css.presetCardBody}>
                      <div className={css.presetCardName}>{t(opt.nameKey)}</div>
                      <div className={css.presetCardDescription}>{t(opt.descriptionKey)}</div>
                    </div>
                  </label>
                )
              })}
              <label
                className={`${css.presetCard} ${!PRESET_IDS.includes(draft.agentPreset as PresetId) ? css.presetCardActive : ''}`}
              >
                <input
                  type="radio"
                  name="agentPreset"
                  value="__custom__"
                  checked={!PRESET_IDS.includes(draft.agentPreset as PresetId)}
                  onChange={() => setDraft({ agentPreset: '' })}
                />
                <div className={css.presetCardBody}>
                  <div className={css.presetCardName}>{t('preset.custom')}</div>
                  {!PRESET_IDS.includes(draft.agentPreset as PresetId) && (
                    <Input
                      className={css.presetCustomInput ?? ''}
                      value={draft.agentPreset}
                      onChange={e => setDraft({ agentPreset: e.target.value })}
                      placeholder="preset id"
                    />
                  )}
                </div>
              </label>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** Render the DingTalk channel settings panel (Webhook + Robot). */
export function DingtalkConfig({
  t,
  listChannels,
  saveChannel,
  deleteChannel,
  setEnabled,
  sendText,
  testChannel,
}: DingtalkConfigProps) {
  const [channels, setChannels] = useState<DingtalkChannel[]>([])
  // Two independent drafts: each section keeps its own typed values.
  const [whDraft, setWhDraft] = useState<TypeDraft>(emptyWebhook)
  const [appDraft, setAppDraft] = useState<TypeDraft>(emptyApp)
  // The modal holds the add/edit form for one channel type at a time.
  const [modalType, setModalType] = useState<DingtalkChannelType>('webhook')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Per-channel send state: draft content + last result detail.
  const [sendDrafts, setSendDrafts] = useState<Record<string, string>>({})
  const [sendResults, setSendResults] = useState<Record<string, string>>({})
  // Delete-confirmation dialog state: the channel pending deletion and whether
  // the user ticked "also remove the robot's workspace directory".
  const [deleteTarget, setDeleteTarget] = useState<DingtalkChannel | null>(null)
  const [deleteWorkspace, setDeleteWorkspace] = useState(false)

  const refresh = async (): Promise<void> => {
    const result = await listChannels({})
    if (result.ok && result.value.ok) setChannels([...result.value.value.channels])
    else setError('list failed')
  }

  useEffect(() => {
    let cancelled = false
    void listChannels({}).then((result) => {
      if (cancelled) return
      if (result.ok && result.value.ok) setChannels([...result.value.value.channels])
      else setError('list failed')
    })
    return () => { cancelled = true }
  }, [listChannels])

  const modalDraft = modalType === 'webhook' ? whDraft : appDraft
  const setModalDraft = (patch: Partial<TypeDraft>): void => {
    if (modalType === 'webhook') setWhDraft({ ...whDraft, ...patch })
    else setAppDraft({ ...appDraft, ...patch })
  }

  /** Open the modal for a fresh channel of the given type. */
  function openAdd(type: DingtalkChannelType): void {
    if (type === 'webhook') setWhDraft(emptyWebhook)
    else setAppDraft(emptyApp)
    setEditingId(null)
    setModalType(type)
    setModalOpen(true)
  }

  /** Open the modal populated with an existing channel for editing. */
  function openEdit(channel: DingtalkChannel): void {
    if (channel.type === 'webhook') {
      setWhDraft({ name: channel.name, webhookUrl: channel.webhookUrl, secret: channel.secret, clientId: '', clientSecret: '', agentPreset: 'minimal', enabled: channel.enabled })
    } else {
      setAppDraft({ name: channel.name, webhookUrl: '', secret: '', clientId: channel.clientId, clientSecret: '', agentPreset: channel.agentPreset, enabled: channel.enabled })
    }
    setEditingId(channel.id)
    setModalType(channel.type)
    setModalOpen(true)
  }

  function closeModal(): void {
    setModalOpen(false)
    setEditingId(null)
  }

  async function handleSubmit(): Promise<void> {
    setError(null)
    const type = modalType
    const draft = modalDraft
    // Reuse the id when editing an existing channel; otherwise auto-generate a
    // fresh one so new channels never collide.
    const id = editingId ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const input: DingtalkChannelInput = type === 'webhook'
      ? {
        id,
        name: draft.name.trim(),
        type: 'webhook',
        webhookUrl: draft.webhookUrl.trim(),
        secret: draft.secret.trim(),
        enabled: draft.enabled,
      }
      : {
        id,
        name: draft.name.trim(),
        type: 'app',
        clientId: draft.clientId.trim(),
        clientSecret: draft.clientSecret.trim(),
        agentPreset: draft.agentPreset.trim(),
        enabled: draft.enabled,
      }
    const result = await saveChannel({ input })
    if (result.ok && result.value.ok) {
      // Reset the form and close the modal on success.
      if (type === 'webhook') setWhDraft(emptyWebhook)
      else setAppDraft(emptyApp)
      setEditingId(null)
      setModalOpen(false)
      await refresh()
    } else {
      const message = !result.ok
        ? `remote error: ${result.error.message}`
        : `save failed: ${result.value.ok ? 'unknown' : result.value.error.message}`
      setError(message)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    // The delete confirmation dialog sets `deleteTarget`; the actual removal
    // happens in confirmDelete once the user confirms (and optionally ticks
    // "also remove the workspace directory").
    setDeleteTarget(channels.find(c => c.id === id) ?? null)
  }

  async function confirmDelete(): Promise<void> {
    if (deleteTarget === null) return
    const target = deleteTarget
    setDeleteTarget(null)
    setDeleteWorkspace(false)
    // Only app (robot) channels own a workspace directory; webhook deletes
    // carry no removeWorkspace flag at all.
    const payload = target.type === 'app'
      ? { id: target.id, removeWorkspace: deleteWorkspace }
      : { id: target.id }
    await deleteChannel(payload)
    await refresh()
  }

  async function handleToggle(channel: DingtalkChannel): Promise<void> {
    await setEnabled({ id: channel.id, enabled: !channel.enabled })
    await refresh()
  }

  /** Send a canned test message; show the outcome next to the channel. */
  async function handleTest(id: string): Promise<void> {
    const result = await testChannel({ id })
    if (!result.ok) {
      setSendResults(prev => ({ ...prev, [id]: `remote error: ${result.error.message}` }))
      return
    }
    const biz = result.value
    if (biz.ok) {
      setSendResults(prev => ({ ...prev, [id]: biz.value.detail }))
    } else {
      setSendResults(prev => ({ ...prev, [id]: `测试失败: ${biz.error.message}` }))
    }
  }

  /** Send the channel's draft text; show the outcome. */
  async function handleSend(id: string): Promise<void> {
    const content = (sendDrafts[id] ?? '').trim()
    if (content.length === 0) {
      setSendResults(prev => ({ ...prev, [id]: 'empty content' }))
      return
    }
    const result = await sendText({ id, content })
    if (!result.ok) {
      setSendResults(prev => ({ ...prev, [id]: `remote error: ${result.error.message}` }))
      return
    }
    const biz = result.value
    if (biz.ok) {
      setSendResults(prev => ({ ...prev, [id]: 'sent ok' }))
    } else {
      setSendResults(prev => ({ ...prev, [id]: `发送失败: ${biz.error.message}` }))
    }
  }

  const webhookChannels = channels.filter(c => c.type === 'webhook')
  const appChannels = channels.filter(c => c.type === 'app')

  const modalTitle = `${editingId !== null ? t('action.edit') : t('action.add')} · ${t(modalType === 'webhook' ? 'type.webhook' : 'type.app')}`

  return (
    <div className={css.panel}>
      {error !== null && <div className={css.error}>{error}</div>}

      {/* Section 1: DingTalk webhook (group custom robot) channels. */}
      <section className={css.card}>
        <div className={css.cardHeader}>
          <h4 className={css.cardTitle}>{t('type.webhook')}</h4>
          <Button variant="outline" size="sm" onClick={() => openAdd('webhook')}>{t('action.add')}</Button>
        </div>
        <ul className={css.channelList}>
          {webhookChannels.map(channel => (
            <li key={channel.id} className={css.channelItem}>
              <div className={css.channelMain}>
                <input
                  type="checkbox"
                  checked={channel.enabled}
                  aria-label={t('action.toggle')}
                  onChange={() => handleToggle(channel)}
                />
                <StateDot state={channel.enabled ? 'done' : 'warning'} />
                <div className={css.channelMeta}>
                  <div className={css.channelName}>{channel.name}</div>
                  <div className={css.channelSub}>{channel.webhookUrl}</div>
                </div>
                <div className={css.channelRight}>
                  <Input
                    className={css.sendInput ?? ''}
                    aria-label={t('action.sendContent')}
                    placeholder={t('action.sendContent')}
                    value={sendDrafts[channel.id] ?? ''}
                    onChange={e => setSendDrafts(prev => ({ ...prev, [channel.id]: e.target.value }))}
                  />
                  <div className={css.channelActions}>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(channel)}>{t('action.edit')}</Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(channel.id)}>{t('action.delete')}</Button>
                    <Button variant="outline" size="sm" onClick={() => handleTest(channel.id)}>{t('action.test')}</Button>
                    <Button variant="primary" size="sm" onClick={() => handleSend(channel.id)}>{t('action.send')}</Button>
                  </div>
                </div>
              </div>
              {sendResults[channel.id] !== undefined && <div className={css.result}>{sendResults[channel.id]}</div>}
            </li>
          ))}
        </ul>
      </section>

      {/* Section 2: DingTalk enterprise-internal-app robot channels. */}
      <section className={css.card}>
        <div className={css.cardHeader}>
          <h4 className={css.cardTitle}>{t('type.app')}</h4>
          <Button variant="outline" size="sm" onClick={() => openAdd('app')}>{t('action.add')}</Button>
        </div>
        <ul className={css.channelList}>
          {appChannels.map(channel => (
            <li key={channel.id} className={css.channelItem}>
              <div className={css.channelMain}>
                <input
                  type="checkbox"
                  checked={channel.enabled}
                  aria-label={t('action.toggle')}
                  onChange={() => handleToggle(channel)}
                />
                <StateDot state={channel.enabled ? 'done' : 'warning'} />
                <div className={css.channelMeta}>
                  <div className={css.channelName}>{channel.name}</div>
                  <div className={css.channelSub}>Client ID: {channel.clientId}（预设: {channel.agentPreset}）</div>
                </div>
                <div className={css.channelRight}>
                  <div className={css.channelActions}>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(channel)}>{t('action.edit')}</Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(channel.id)}>{t('action.delete')}</Button>
                    <Button variant="outline" size="sm" onClick={() => handleTest(channel.id)}>{t('action.test')}</Button>
                  </div>
                </div>
              </div>
              {sendResults[channel.id] !== undefined && <div className={css.result}>{sendResults[channel.id]}</div>}
            </li>
          ))}
        </ul>
      </section>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={modalTitle}
        closeLabel={t('action.close')}
        className={css.modalDialog ?? ''}
        contentClassName={css.modalContent ?? ''}
        footer={(
          <>
            <Button variant="ghost" onClick={closeModal}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={handleSubmit}>{editingId !== null ? t('action.save') : t('action.add')}</Button>
          </>
        )}
      >
        <ChannelForm type={modalType} draft={modalDraft} setDraft={setModalDraft} t={t} />
      </Modal>

      {/* Delete confirmation: app (robot) channels additionally offer removing
          the dedicated workspace directory (it holds the session history). */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => { setDeleteTarget(null); setDeleteWorkspace(false) }}
        title={t('delete.title')}
        closeLabel={t('action.close')}
        className={css.modalDialog ?? ''}
        contentClassName={css.modalContent ?? ''}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setDeleteTarget(null); setDeleteWorkspace(false) }}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={confirmDelete}>{t('action.delete')}</Button>
          </>
        )}
      >
        <p className={css.deleteMessage}>
          {t('delete.confirm')}「{deleteTarget?.name}」？
        </p>
        {deleteTarget?.type === 'app' && (
          <label className={css.deleteOption}>
            <input
              type="checkbox"
              checked={deleteWorkspace}
              onChange={e => setDeleteWorkspace(e.target.checked)}
            />
            <span>{t('delete.removeWorkspace')}</span>
          </label>
        )}
      </Modal>
    </div>
  )
}
