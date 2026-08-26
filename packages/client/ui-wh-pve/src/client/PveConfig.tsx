import { useEffect, useState } from 'react'
import { Button, Input, StateDot, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PveCollectRequest,
  PveCollectResult,
  PveCollectTestRequest,
  PveCollectTestResult,
  PveDeleteRequest,
  PveDeleteResult,
  PveListRequest,
  PveListResult,
  PveSaveRequest,
  PveSaveResult,
  PveServer,
  PveServerInput,
  PveSetEnabledRequest,
  PveSetEnabledResult,
} from '@deepseek-ai/dsh-pve-host/types'
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
  collectNow: (request: PveCollectRequest) => Promise<RemoteResult<PveCollectResult>>
  collectTest: (request: PveCollectTestRequest) => Promise<RemoteResult<PveCollectTestResult>>
}

/** The verbs-only subset registered by the Host Remote (`t` comes from locale). */
export type PveInjected = Omit<PveConfigProps, 't'>

/** One server's editable draft; token secret blank = keep stored. */
interface ServerDraft {
  id: string
  name: string
  apiUrl: string
  apiTokenId: string
  apiTokenSecret: string
  node: string
  remark: string
  enabled: boolean
  systemLogEnabled: boolean
}

const emptyDraft: ServerDraft = {
  id: '', name: '', apiUrl: 'https://', apiTokenId: '', apiTokenSecret: '',
  node: 'pve', remark: '', enabled: true, systemLogEnabled: false,
}

function serverToDraft(s: PveServer): ServerDraft {
  return {
    id: s.id, name: s.name, apiUrl: s.apiUrl, apiTokenId: s.apiTokenId,
    apiTokenSecret: '', node: s.node, remark: s.remark, enabled: s.enabled, systemLogEnabled: s.systemLogEnabled,
  }
}

/** The shared field editor rendered inside the add/edit modal. */
function ServerForm({ draft, setDraft, t }: {
  draft: ServerDraft
  setDraft: (patch: Partial<ServerDraft>) => void
  t: (key: PveKey) => string
}) {
  return (
    <div className={css.form}>
      <div className={css.formRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.name')}</span>
          <Input aria-label={t('field.name')} placeholder={t('field.name')} value={draft.name} onChange={e => setDraft({ name: e.target.value })} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.apiUrl')}</span>
          <Input aria-label={t('field.apiUrl')} placeholder="https://10.0.0.1:8006" value={draft.apiUrl} onChange={e => setDraft({ apiUrl: e.target.value })} />
        </label>
      </div>
      <div className={css.formRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.apiTokenId')}</span>
          <Input aria-label={t('field.apiTokenId')} placeholder="root@pam!mytoken" value={draft.apiTokenId} onChange={e => setDraft({ apiTokenId: e.target.value })} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.apiTokenSecret')}</span>
          <Input type="password" aria-label={t('field.apiTokenSecret')} placeholder={t('field.apiTokenSecret')} value={draft.apiTokenSecret} onChange={e => setDraft({ apiTokenSecret: e.target.value })} />
        </label>
      </div>
      <div className={css.formRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.node')}</span>
          <Input aria-label={t('field.node')} placeholder="pve" value={draft.node} onChange={e => setDraft({ node: e.target.value })} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('field.remark')}</span>
          <Input aria-label={t('field.remark')} placeholder={t('field.remark')} value={draft.remark} onChange={e => setDraft({ remark: e.target.value })} />
        </label>
      </div>
      <div className={css.formRow}>
        <div className={css.field}>
          <span className={css.fieldLabel}>{t('field.systemLog')}</span>
          <label className={css.deleteOption}>
            <input type="checkbox" checked={draft.systemLogEnabled} onChange={e => setDraft({ systemLogEnabled: e.target.checked })} />
            <span>{t('option.yes')}</span>
          </label>
        </div>
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
  collectNow,
  collectTest,
}: PveConfigProps) {
  const [servers, setServers] = useState<PveServer[]>([])
  const [draft, setDraftState] = useState<ServerDraft>(emptyDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    })()
    return () => { cancelled = true }
  }, [listServers])

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
    if (draft.name.trim().length === 0 || draft.apiUrl.trim().length === 0 || draft.apiTokenId.trim().length === 0 || draft.node.trim().length === 0) {
      setError('name, apiUrl, apiTokenId and node are required')
      return
    }
    const input: PveServerInput = {
      id: draft.id,
      name: draft.name.trim(),
      apiUrl: draft.apiUrl.trim(),
      apiTokenId: draft.apiTokenId.trim(),
      apiTokenSecret: draft.apiTokenSecret, // blank = keep stored
      node: draft.node.trim(),
      enabled: draft.enabled,
      systemLogEnabled: draft.systemLogEnabled,
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
    const sysMsg = v.systemReported > 0 ? ` · ${t('result.systemLog').replace('{n}', String(v.systemReported))}` : ''
    setResults(prev => ({ ...prev, [id]: `${t('result.ok')} · ${msg}${sysMsg}` }))
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
    console.log(`[pve] 采集测试 ${id}：读取 ${v.lines} 行，解析 ${v.entries} 条，新失败 ${v.fresh.length} 条，系统日志 ${v.systemLogs.length} 条`)
    if (v.fresh.length === 0) {
      console.log('[pve] 没有新的失败任务')
    } else {
      for (const task of v.fresh) {
        console.log(`[pve] [${task.status}] ${task.upid}（${task.type} ${task.target}，用户 ${task.user}）`)
      }
    }
    if (v.systemLogs.length > 0) {
      for (const e of v.systemLogs) {
        console.log(`[pve] [${e.priority}] ${e.ts} · ${e.unit} · ${e.message}`)
      }
    } else {
      console.log('[pve] 没有新的系统日志')
    }
    const detail = v.fresh.length === 0
      ? ''
      : '\n' + v.fresh
        .map((task, i) => `${i + 1}. [${task.status}] ${task.upid}（${task.type} ${task.target}，用户 ${task.user}）`)
        .join('\n')
    const sysDetail = v.systemLogs.length === 0
      ? ''
      : '\n' + v.systemLogs
        .map((e, i) => `${i + 1}. [${e.priority}] ${e.ts} · ${e.unit} · ${e.message}`)
        .join('\n')
    setResults(prev => ({
      ...prev,
      [id]: `${t('result.test')} · ${t('result.testSummary')
        .replace('{lines}', String(v.lines))
        .replace('{entries}', String(v.entries))
        .replace('{fresh}', String(v.fresh.length))
        .replace('{report}', String(v.wouldReport))} · ${t('result.systemLog').replace('{n}', String(v.systemLogs.length))}${detail}${sysDetail}`,
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
      <ul className={css.serverList}>
        {servers.map(server => (
          <li key={server.id} className={css.serverItem}>
            <div className={css.serverMain}>
              <input type="checkbox" checked={server.enabled} aria-label={t('action.toggle')} onChange={() => handleToggle(server)} />
              <StateDot state={server.enabled ? 'done' : 'warning'} />
              <div className={css.serverMeta}>
                <div className={css.serverName}>{server.name}</div>
                <div className={css.serverSub}>{server.apiUrl} · {server.node}{server.remark ? ` · ${server.remark}` : ''}</div>
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
        <ServerForm draft={draft} setDraft={setDraft} t={t} />
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
