import { useEffect, useState } from 'react'
import { Button, Input, StateDot, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PveCollectRequest,
  PveCollectResult,
  PveCollectTestRequest,
  PveCollectTestResult,
  PveDeleteRequest,
  PveDeleteResult,
  PveListModelsRequest,
  PveListModelsResult,
  PveListRequest,
  PveListResult,
  PveModelGroup,
  PveSaveRequest,
  PveSaveResult,
  PveServer,
  PveServerInput,
  PveSetEnabledRequest,
  PveSetEnabledResult,
  PveSetPushEnabledRequest,
  PveSetPushEnabledResult,
} from '@deepseek-ai/dsh-pve-host/types'
import type {
  DingtalkChannel,
  DingtalkListRequest,
  DingtalkListResult,
} from '@deepseek-ai/dsh-dingtalk-host/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import css from './Pve.module.css'
import type { PveKey } from './locales.ts'

/** The Remote verbs injected by the slot renderer (locale `t` injected separately). */
export interface PveConfigProps {
  t: (key: PveKey) => string
  listServers: (_request: PveListRequest) => Promise<RemoteResult<PveListResult>>
  saveServer: (request: PveSaveRequest) => Promise<RemoteResult<PveSaveResult>>
  deleteServer: (request: PveDeleteRequest) => Promise<RemoteResult<PveDeleteResult>>
  setEnabled: (request: PveSetEnabledRequest) => Promise<RemoteResult<PveSetEnabledResult>>
  setPushEnabled: (request: PveSetPushEnabledRequest) => Promise<RemoteResult<PveSetPushEnabledResult>>
  collectNow: (request: PveCollectRequest) => Promise<RemoteResult<PveCollectResult>>
  collectTest: (request: PveCollectTestRequest) => Promise<RemoteResult<PveCollectTestResult>>
  listChannels: (_request: DingtalkListRequest) => Promise<RemoteResult<DingtalkListResult>>
  listModels: (_request: PveListModelsRequest) => Promise<RemoteResult<PveListModelsResult>>
}

/** The verbs-only subset registered by the Host Remote (`t` comes from locale). */
export type PveInjected = Omit<PveConfigProps, 't'>

/** One server's editable draft; password blank = keep stored. */
interface ServerDraft {
  id: string
  name: string
  host: string
  port: number
  username: string
  password: string
  remark: string
  enabled: boolean
  pushEnabled: boolean
  channelIds: string[]
  aiEnabled: boolean
  aiPrompt: string
  aiModelProvider: string
  aiModelName: string
}

const emptyDraft: ServerDraft = {
  id: '', name: '', host: '', port: 22, username: 'root', password: '',
  remark: '', enabled: true, pushEnabled: true, channelIds: [], aiEnabled: false,
  aiPrompt: '', aiModelProvider: '', aiModelName: '',
}

function toModelRef(d: ServerDraft): { provider: string; model: string } | null {
  if (d.aiModelProvider === '' || d.aiModelName === '') return null
  return { provider: d.aiModelProvider, model: d.aiModelName }
}

function serverToDraft(s: PveServer): ServerDraft {
  return {
    id: s.id, name: s.name, host: s.host, port: s.port, username: s.username,
    password: '', remark: s.remark, enabled: s.enabled, pushEnabled: s.pushEnabled, channelIds: [...s.channelIds],
    aiEnabled: s.aiEnabled, aiPrompt: s.aiPrompt,
    aiModelProvider: s.aiModel?.provider ?? '', aiModelName: s.aiModel?.model ?? '',
  }
}

/** The shared field editor rendered inside the add/edit modal. */
function ServerForm({ draft, setDraft, t, channels, models }: {
  draft: ServerDraft
  setDraft: (patch: Partial<ServerDraft>) => void
  t: (key: PveKey) => string
  channels: DingtalkChannel[]
  models: PveModelGroup[]
}) {
  const setChannel = (id: string, on: boolean) => {
    const next = on ? [...draft.channelIds, id] : draft.channelIds.filter(c => c !== id)
    setDraft({ channelIds: next })
  }
  const setModel = (value: string) => {
    if (value === '') { setDraft({ aiModelProvider: '', aiModelName: '' }); return }
    const [provider = '', model = ''] = value.split('::')
    setDraft({ aiModelProvider: provider, aiModelName: model })
  }
  const modelValue = draft.aiModelProvider === '' ? '' : `${draft.aiModelProvider}::${draft.aiModelName}`
  return (
    <div className={css.form}>
      <div className={css.formRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.name')}</span>
          <Input aria-label={t('field.name')} placeholder={t('field.name')} value={draft.name} onChange={e => setDraft({ name: e.target.value })} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.host')}</span>
          <Input aria-label={t('field.host')} placeholder="10.0.0.1" value={draft.host} onChange={e => setDraft({ host: e.target.value })} />
        </label>
      </div>
      <div className={css.formRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.port')}</span>
          <Input aria-label={t('field.port')} placeholder="22" value={String(draft.port)} onChange={e => setDraft({ port: Number(e.target.value) || 0 })} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.username')}</span>
          <Input aria-label={t('field.username')} placeholder="root" value={draft.username} onChange={e => setDraft({ username: e.target.value })} />
        </label>
      </div>
      <div className={css.formRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.password')}</span>
          <Input type="password" aria-label={t('field.password')} placeholder={t('field.password')} value={draft.password} onChange={e => setDraft({ password: e.target.value })} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.remark')}</span>
          <Input aria-label={t('field.remark')} placeholder={t('field.remark')} value={draft.remark} onChange={e => setDraft({ remark: e.target.value })} />
        </label>
      </div>

      <div className={css.field}>
        <span className={css.fieldLabel}>{t('field.channelIds')}</span>
        {channels.length === 0 ? (
          <div className={css.hint}>{t('channel.none')}</div>
        ) : (
          <div className={css.channelGroups}>
            {(['webhook', 'app'] as const).map((type) => {
              const group = channels.filter(c => c.type === type)
              if (group.length === 0) return null
              return (
                <div key={type} className={css.channelGroup}>
                  <div className={css.channelGroupLabel}>{type === 'webhook' ? t('channel.groupWebhook') : t('channel.groupRobot')}</div>
                  <div className={css.channelGrid}>
                    {group.map(c => (
                      <label key={c.id} className={css.channelToggle}>
                        <input type="checkbox" checked={draft.channelIds.includes(c.id)} onChange={e => setChannel(c.id, e.target.checked)} />
                        <span>{c.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className={css.field}>
        <span className={css.fieldLabel}>{t('field.aiEnabled')}</span>
        <div className={css.radioGroup}>
          <label className={css.inlineToggle}>
            <input type="radio" name="pve-ai-enabled" checked={draft.aiEnabled} onChange={() => setDraft({ aiEnabled: true })} />
            <span>{t('option.yes')}</span>
          </label>
          <label className={css.inlineToggle}>
            <input type="radio" name="pve-ai-enabled" checked={!draft.aiEnabled} onChange={() => setDraft({ aiEnabled: false })} />
            <span>{t('option.no')}</span>
          </label>
        </div>
      </div>
      <div className={css.aiConfigGroup}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.aiPrompt')}</span>
          <textarea
            className={css.textarea}
            rows={3}
            aria-label={t('field.aiPrompt')}
            placeholder={t('field.aiPrompt')}
            value={draft.aiPrompt}
            onChange={e => setDraft({ aiPrompt: e.target.value })}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.aiModel')}</span>
          <select className={css.select} aria-label={t('field.aiModel')} value={modelValue} onChange={e => setModel(e.target.value)}>
            <option value="">{t('model.placeholder')}</option>
            {models.map(g => g.models.map(m => (
              <option key={`${g.provider}::${m}`} value={`${g.provider}::${m}`}>{g.provider} / {m}</option>
            )))}
          </select>
        </label>
      </div>
    </div>
  )
}

/** Render the PVE server settings panel. */
export function PveConfig({
  t,
  listServers,
  saveServer,
  deleteServer,
  setEnabled,
  setPushEnabled,
  collectNow,
  collectTest,
  listChannels,
  listModels,
}: PveConfigProps) {
  const [servers, setServers] = useState<PveServer[]>([])
  const [draft, setDraftState] = useState<ServerDraft>(emptyDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [channels, setChannels] = useState<DingtalkChannel[]>([])
  const [models, setModels] = useState<PveModelGroup[]>([])
  const [modelLoadError, setModelLoadError] = useState(false)
  const [results, setResults] = useState<Record<string, string>>({})
  const [deleteTarget, setDeleteTarget] = useState<PveServer | null>(null)
  const [removeState, setRemoveState] = useState(false)

  const setDraft = (patch: Partial<ServerDraft>) => setDraftState(s => ({ ...s, ...patch }))

  const refresh = async () => {
    const result = await listServers({})
    if (result.ok && result.value?.ok) setServers([...result.value.value.servers])
    else setError('list failed')
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const sr = await listServers({})
      if (!cancelled && sr.ok && sr.value?.ok) setServers([...sr.value.value.servers])
      const cr = await listChannels({})
      if (!cancelled && cr.ok && cr.value?.ok) setChannels([...cr.value.value.channels])
      const mr = await listModels({})
      if (!cancelled) {
        if (mr.ok && mr.value?.ok) setModels([...mr.value.value.groups])
        else setModelLoadError(true)
      }
    })()
    return () => { cancelled = true }
  }, [listServers, listChannels, listModels])

  function openAdd() {
    setDraftState({ ...emptyDraft, id: crypto.randomUUID() })
    setEditingId(null)
    setModalOpen(true)
  }

  function openEdit(server: PveServer) {
    setDraftState(serverToDraft(server))
    setEditingId(server.id)
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setEditingId(null)
    setError(null)
  }

  async function handleSubmit() {
    setError(null)
    if (draft.name.trim().length === 0 || draft.host.trim().length === 0) {
      setError('name and host are required')
      return
    }
    const input: PveServerInput = {
      id: draft.id,
      name: draft.name.trim(),
      host: draft.host.trim(),
      port: draft.port,
      username: draft.username.trim(),
      password: draft.password, // blank = keep stored
      enabled: draft.enabled,
      pushEnabled: draft.pushEnabled,
      channelIds: draft.channelIds,
      aiEnabled: draft.aiEnabled,
      aiPrompt: draft.aiPrompt,
      aiModel: toModelRef(draft),
      remark: draft.remark,
    }
    const result = await saveServer({ input })
    if (!result.ok) {
      setError('remote error')
    } else if (!result.value.ok) {
      setError(result.value.error.message)
    } else {
      closeModal()
      await refresh()
    }
  }

  async function handleDelete(id: string) {
    setDeleteTarget(servers.find(s => s.id === id) ?? null)
  }

  async function confirmDelete() {
    if (deleteTarget === null) return
    const target = deleteTarget
    setDeleteTarget(null)
    setRemoveState(false)
    await deleteServer({ id: target.id, removeState })
    await refresh()
  }

  async function handleToggle(server: PveServer) {
    await setEnabled({ id: server.id, enabled: !server.enabled })
    await refresh()
  }

  async function handleTogglePush(server: PveServer) {
    await setPushEnabled({ id: server.id, pushEnabled: !server.pushEnabled })
    await refresh()
  }

  async function handleCollect(id: string) {
    const result = await collectNow({ id })
    if (!result.ok || !result.value?.ok) {
      setResults(prev => ({ ...prev, [id]: t('result.error').replace('{msg}', 'remote error') }))
      return
    }
    const v = result.value.value
    const msg = v.reported > 0
      ? t('result.reported').replace('{n}', String(v.reported))
      : t('result.noNew')
    setResults(prev => ({ ...prev, [id]: `${t('result.ok')} · ${msg}` }))
  }

  /** Probe one server without sending: log readable collected tasks, show a summary. */
  async function handleCollectTest(id: string) {
    const result = await collectTest({ id })
    if (!result.ok || !result.value?.ok) {
      console.log(`[pve] 采集测试 ${id} 失败: remote error`)
      setResults(prev => ({ ...prev, [id]: t('result.error').replace('{msg}', 'remote error') }))
      return
    }
    const v = result.value.value
    if (!v.ok) {
      console.log(`[pve] 采集测试 ${id} 失败: ${v.error}`)
      setResults(prev => ({ ...prev, [id]: t('result.error').replace('{msg}', v.error) }))
      return
    }
    console.log(`[pve] 采集测试 ${id}：读取 ${v.lines} 行，解析 ${v.entries} 条，新失败 ${v.fresh.length} 条，将推送 ${v.wouldReport} 条`)
    if (v.fresh.length === 0) {
      console.log('[pve] 没有新的失败任务')
    } else {
      for (const task of v.fresh) {
        console.log(`[pve] [${task.status}] ${task.upid}（${task.type} ${task.target}，用户 ${task.user}）`)
      }
    }
    setResults(prev => ({
      ...prev,
      [id]: `${t('result.test')} · ${t('result.testSummary')
        .replace('{lines}', String(v.lines))
        .replace('{entries}', String(v.entries))
        .replace('{fresh}', String(v.fresh.length))
        .replace('{report}', String(v.wouldReport))}`,
    }))
  }

  const modalTitle = editingId !== null ? t('action.edit') : t('action.add')

  return (
    <div className={css.panel}>
      <div className={css.panelHeader}>
        <h3 className={css.pageTitle}>{t('title')}</h3>
        <Button variant="outline" size="sm" onClick={openAdd}>{t('action.add')}</Button>
      </div>
      {error !== null && <div className={css.error}>{error}</div>}
      {modelLoadError && <div className={css.hint}>{t('model.loadError')}</div>}
      <ul className={css.serverList}>
        {servers.map(server => (
          <li key={server.id} className={css.serverItem}>
            <div className={css.serverMain}>
              <input type="checkbox" checked={server.enabled} aria-label={t('action.toggle')} onChange={() => handleToggle(server)} />
              <label className={css.pushToggle} title={t('field.pushEnabled')}>
                <input type="checkbox" checked={server.pushEnabled} aria-label={t('field.pushEnabled')} onChange={() => handleTogglePush(server)} />
                <span>{t('field.pushEnabled')}</span>
              </label>
              <StateDot state={server.enabled ? 'done' : 'warning'} />
              <div className={css.serverMeta}>
                <div className={css.serverName}>{server.name}</div>
                <div className={css.serverSub}>{server.host}:{server.port} · {server.username}{server.remark ? ` · ${server.remark}` : ''}</div>
                <div className={css.serverTags}>
                  {server.channelIds.length > 0 && <span className={css.tag}>通道 {server.channelIds.length}</span>}
                </div>
                <div>
                  {server.aiPrompt && <span className={css.tagAi}>AI 提示词</span>}
                  {server.aiEnabled && <span className={css.tagAi}>AI 分析</span>}

                </div>
              </div>
              <div className={css.serverActions}>
                <Button variant="ghost" size="sm" onClick={() => openEdit(server)}>{t('action.edit')}</Button>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(server.id)}>{t('action.delete')}</Button>
                <Button variant="ghost" size="sm" onClick={() => handleCollectTest(server.id)}>{t('action.collectTest')}</Button>
                <Button variant="primary" size="sm" onClick={() => handleCollect(server.id)}>{t('action.collect')}</Button>
              </div>
            </div>
            {results[server.id] !== undefined && <div className={css.result}>{results[server.id]}</div>}
          </li>
        ))}
        {servers.length === 0 && <div className={css.hint}>{t('list.all')}：暂无服务器</div>}
      </ul>

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
        <ServerForm draft={draft} setDraft={setDraft} t={t} channels={channels} models={models} />
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => { setDeleteTarget(null); setRemoveState(false) }}
        title={t('delete.title')}
        closeLabel={t('action.close')}
        className={css.modalDialog ?? ''}
        contentClassName={css.modalContent ?? ''}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setDeleteTarget(null); setRemoveState(false) }}>{t('action.cancel')}</Button>
            <Button variant="primary" onClick={confirmDelete}>{t('action.delete')}</Button>
          </>
        )}
      >
        <p className={css.deleteMessage}>{t('delete.confirm')}「{deleteTarget?.name}」？</p>
        <label className={css.deleteOption}>
          <input type="checkbox" checked={removeState} onChange={e => setRemoveState(e.target.checked)} />
          <span>{t('delete.removeState')}</span>
        </label>
        <div className={css.hint}>{t('delete.removeStateHint')}</div>
      </Modal>
    </div>
  )
}
