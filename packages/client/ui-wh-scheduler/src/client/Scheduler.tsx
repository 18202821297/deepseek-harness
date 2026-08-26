import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Modal, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SchedulerChannelRef,
  SchedulerDeleteRequest, SchedulerDeleteResult,
  SchedulerGetSettingsRequest, SchedulerGetSettingsResult,
  SchedulerJob, SchedulerJobInput,
  SchedulerListChannelsRequest, SchedulerListChannelsResult,
  SchedulerListModelsRequest, SchedulerListModelsResult,
  SchedulerListPveServersRequest, SchedulerListPveServersResult,
  SchedulerListRequest, SchedulerListResult,
  SchedulerListSkillsRequest, SchedulerListSkillsResult,
  SchedulerModelGroup, SchedulerModelRef,
  SchedulerPveServerRef,
  SchedulerRunNowRequest, SchedulerRunNowResult,
  SchedulerSaveRequest, SchedulerSaveResult,
  SchedulerSaveSettingsRequest, SchedulerSaveSettingsResult,
  SchedulerSetEnabledRequest, SchedulerSetEnabledResult,
  SchedulerSkillRef,
} from '@deepseek-ai/dsh-scheduler-host/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import css from './Scheduler.module.css'
import type { SchedulerKey } from './locales.ts'

/** Required-field red asterisk marker. */
function Req(): React.JSX.Element {
  return <span className={css.req}> *</span>
}

/** Ordered distinct channel types for grouped display; unknown types appended last. */
function channelGroupTypes(channels: readonly SchedulerChannelRef[]): string[] {
  const known = ['webhook', 'app']
  const rest = channels.map(c => c.type).filter((t, i, arr) => arr.indexOf(t) === i && !known.includes(t))
  return [...known.filter(t => channels.some(c => c.type === t)), ...rest]
}

/** Human-readable channel-type label; unknown types fall back to their raw name. */
function channelTypeLabel(type: string, t: (key: SchedulerKey) => string): string {
  switch (type) {
    case 'webhook': return t('channel.groupWebhook')
    case 'app': return t('channel.groupRobot')
    default: return type
  }
}

export interface SchedulerConfigProps {
  t: (key: SchedulerKey) => string
  listJobs: (_request: SchedulerListRequest) => Promise<RemoteResult<SchedulerListResult>>
  saveJob: (request: SchedulerSaveRequest) => Promise<RemoteResult<SchedulerSaveResult>>
  deleteJob: (request: SchedulerDeleteRequest) => Promise<RemoteResult<SchedulerDeleteResult>>
  setEnabled: (request: SchedulerSetEnabledRequest) => Promise<RemoteResult<SchedulerSetEnabledResult>>
  runNow: (request: SchedulerRunNowRequest) => Promise<RemoteResult<SchedulerRunNowResult>>
  getSettings: (_request: SchedulerGetSettingsRequest) => Promise<RemoteResult<SchedulerGetSettingsResult>>
  saveSettings: (request: SchedulerSaveSettingsRequest) => Promise<RemoteResult<SchedulerSaveSettingsResult>>
  listPveServers: (_request: SchedulerListPveServersRequest) => Promise<RemoteResult<SchedulerListPveServersResult>>
  listChannels: (_request: SchedulerListChannelsRequest) => Promise<RemoteResult<SchedulerListChannelsResult>>
  listModels: (_request: SchedulerListModelsRequest) => Promise<RemoteResult<SchedulerListModelsResult>>
  listSkills: (_request: SchedulerListSkillsRequest) => Promise<RemoteResult<SchedulerListSkillsResult>>
}

export type SchedulerInjected = Omit<SchedulerConfigProps, 't'>

/** Cron generator state: which schedule shape the user is composing. */
interface CronState {
  kind: 'interval' | 'daily' | 'monthly' | 'yearly'
  every: number
  everyUnit: 'minute' | 'hour'
  dailyTime: string
  monthlyDay: number
  monthlyTime: string
  yearlyMonth: number
  yearlyDay: number
  yearlyTime: string
}

const emptyCron = (): CronState => ({
  kind: 'interval', every: 5, everyUnit: 'minute',
  dailyTime: '09:00', monthlyDay: 1, monthlyTime: '09:00',
  yearlyMonth: 1, yearlyDay: 1, yearlyTime: '09:00',
})

function parseFieldNum(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null
  const n = Number(field)
  return n >= min && n <= max ? n : null
}

/** Reverse a 5-field cron expression back into the generator state. Returns null when the shape is not one of the supported presets. */
function parseCronToState(cron: string): CronState | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hour, dom, month, dow] = parts
  if (minute === undefined || hour === undefined || dom === undefined || month === undefined || dow === undefined) return null

  // every N minutes: */n * * * *
  const minuteStep = /^\*\/(\d{1,2})$/.exec(minute)
  if (minuteStep !== null) {
    const step = Number(minuteStep[1])
    if (step >= 1 && step <= 59 && hour === '*' && dom === '*' && month === '*' && dow === '*') {
      return { ...emptyCron(), kind: 'interval', every: step, everyUnit: 'minute' }
    }
  }

  // every N hours: 0 */n * * *
  if (minute === '0') {
    const hourStep = /^\*\/(\d{1,2})$/.exec(hour)
    if (hourStep !== null) {
      const step = Number(hourStep[1])
      if (step >= 1 && step <= 23 && dom === '*' && month === '*' && dow === '*') {
        return { ...emptyCron(), kind: 'interval', every: step, everyUnit: 'hour' }
      }
    }
  }

  const m = parseFieldNum(minute, 0, 59)
  const h = parseFieldNum(hour, 0, 23)
  if (m === null || h === null) return null
  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

  // daily: m h * * *
  if (dom === '*' && month === '*' && dow === '*') {
    return { ...emptyCron(), kind: 'daily', dailyTime: time }
  }

  // monthly: m h D * *
  const d = parseFieldNum(dom, 1, 31)
  if (d !== null && month === '*' && dow === '*') {
    return { ...emptyCron(), kind: 'monthly', monthlyDay: d, monthlyTime: time }
  }

  // yearly: m h D M *
  const mo = parseFieldNum(month, 1, 12)
  if (d !== null && mo !== null && dow === '*') {
    return { ...emptyCron(), kind: 'yearly', yearlyMonth: mo, yearlyDay: d, yearlyTime: time }
  }

  return null
}

/** Build a 5-field cron expression from the generator state. */
function buildCron(s: CronState): string {
  const hhmm = (v: string): { h: string; m: string } => {
    const [h = '0', m = '0'] = v.split(':')
    return { h: h.padStart(2, '0'), m: m.padStart(2, '0') }
  }
  switch (s.kind) {
    case 'interval':
      if (s.everyUnit === 'minute') {
        const step = Math.max(1, Math.min(59, Math.floor(s.every)))
        return `*/${step} * * * *`
      }
      return `0 */${Math.max(1, Math.min(23, Math.floor(s.every)))} * * *`
    case 'daily': {
      const { h, m } = hhmm(s.dailyTime)
      return `${m} ${h} * * *`
    }
    case 'monthly': {
      const { h, m } = hhmm(s.monthlyTime)
      return `${m} ${h} ${Math.max(1, Math.min(31, s.monthlyDay))} * *`
    }
    case 'yearly': {
      const { h, m } = hhmm(s.yearlyTime)
      return `${m} ${h} ${Math.max(1, Math.min(31, s.yearlyDay))} ${Math.max(1, Math.min(12, s.yearlyMonth))} *`
    }
  }
}

/** Cron generator: pick a schedule shape, auto-produce the cron expression. */
function CronBuilder({ t, value, onChange }: {
  t: (key: SchedulerKey) => string
  value: string
  onChange: (cron: string) => void
}) {
  const [state, setState] = useState<CronState>(() => parseCronToState(value) ?? emptyCron())
  useEffect(() => {
    const parsed = parseCronToState(value)
    if (parsed !== null) setState(parsed)
  }, [value])
  const set = (patch: Partial<CronState>) => {
    const next = { ...state, ...patch }
    setState(next)
    onChange(buildCron(next))
  }
  const pick = (kind: CronState['kind']) => set({ kind })
  return (
    <div className={css.cronBuilder}>
      <div className={css.cronTabs}>
        {(['interval', 'daily', 'monthly', 'yearly'] as const).map(kind => (
          <button key={kind} type="button"
            className={`${css.cronTab} ${state.kind === kind ? css.cronTabActive : ''}`}
            onClick={() => pick(kind)}>
            {t(kind === 'interval' ? 'cron.interval' : kind === 'daily' ? 'cron.daily' : kind === 'monthly' ? 'cron.monthly' : 'cron.yearly')}
          </button>
        ))}
      </div>

      {state.kind === 'interval' && (
        <div className={css.cronRow}>
          <span>{t('cron.every')}</span>
          <input type="number" min={1} max={state.everyUnit === 'minute' ? 60 : 24} className={css.cronInput}
            value={state.every} onChange={e => set({ every: Number(e.target.value) || 1 })} />
          <select className={css.cronSelect} value={state.everyUnit} onChange={e => set({ everyUnit: e.target.value as 'minute' | 'hour' })}>
            <option value="minute">{t('cron.minutes')}</option>
            <option value="hour">{t('cron.hours')}</option>
          </select>
        </div>
      )}
      {state.kind === 'daily' && (
        <div className={css.cronRow}>
          <span>{t('cron.daily')}</span>
          <input type="time" className={css.cronInput} value={state.dailyTime} onChange={e => set({ dailyTime: e.target.value })} />
        </div>
      )}
      {state.kind === 'monthly' && (
        <div className={css.cronRow}>
          <span>{t('cron.monthly')}</span>
          <input type="number" min={1} max={31} className={css.cronInput} value={state.monthlyDay}
            onChange={e => set({ monthlyDay: Number(e.target.value) || 1 })} />
          <span>{t('cron.day')}</span>
          <input type="time" className={css.cronInput} value={state.monthlyTime} onChange={e => set({ monthlyTime: e.target.value })} />
        </div>
      )}
      {state.kind === 'yearly' && (
        <div className={css.cronRow}>
          <span>{t('cron.yearly')}</span>
          <input type="number" min={1} max={12} className={css.cronInput} value={state.yearlyMonth}
            onChange={e => set({ yearlyMonth: Number(e.target.value) || 1 })} />
          <span>{t('cron.month')}</span>
          <input type="number" min={1} max={31} className={css.cronInput} value={state.yearlyDay}
            onChange={e => set({ yearlyDay: Number(e.target.value) || 1 })} />
          <span>{t('cron.day')}</span>
          <input type="time" className={css.cronInput} value={state.yearlyTime} onChange={e => set({ yearlyTime: e.target.value })} />
        </div>
      )}
      <div className={css.cronPreview}>
        <span>{t('field.cron')}</span>
        <code>{value}</code>
      </div>
    </div>
  )
}

interface JobDraft {
  id: string
  name: string
  type: 'pve' | 'agent'
  cron: string
  enabled: boolean
  pveServerId: string
  aiEnabled: boolean
  prompt: string
  skillName: string
  model: string
  channelIds: string[]
}

const emptyDraft = (type: 'pve' | 'agent'): JobDraft => ({
  id: '', name: '', type, cron: '*/5 * * * *', enabled: true,
  pveServerId: '', aiEnabled: false, prompt: '', skillName: '', model: '', channelIds: [],
})

function formatTime(iso: string | null, t: (key: SchedulerKey) => string): string {
  if (iso === null) return t('state.never')
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function SchedulerConfig({
  t, listJobs, saveJob, deleteJob, setEnabled, runNow,
  getSettings, saveSettings,
  listPveServers, listChannels, listModels, listSkills,
}: SchedulerConfigProps) {
  const [jobs, setJobs] = useState<SchedulerJob[]>([])
  const [servers, setServers] = useState<SchedulerPveServerRef[]>([])
  const [channels, setChannels] = useState<SchedulerChannelRef[]>([])
  const [modelGroups, setModelGroups] = useState<SchedulerModelGroup[]>([])
  const [skills, setSkills] = useState<SchedulerSkillRef[]>([])
  const [pickOpen, setPickOpen] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [skillPickOpen, setSkillPickOpen] = useState(false)
  const [draft, setDraft] = useState<JobDraft>(emptyDraft('agent'))
  const [deleteTarget, setDeleteTarget] = useState<SchedulerJob | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /** Per-job run-log display count (5/10/20/50/200), default 10. */
  const [logLimits, setLogLimits] = useState<Record<string, number>>({})
  /** Job whose run logs are shown in the pop-up viewer (null = closed). */
  const [logModalJob, setLogModalJob] = useState<SchedulerJob | null>(null)
  /** Module-level global AI concurrency (shown/edited at the page top). */
  const [globalAiDraft, setGlobalAiDraft] = useState('4')
  const [savingGlobal, setSavingGlobal] = useState(false)

  const loadSettings = useCallback(async () => {
    const r = await getSettings({})
    if (r.ok && r.value.ok) setGlobalAiDraft(String(r.value.value.aiConcurrency))
  }, [getSettings])

  useEffect(() => { void loadSettings() }, [loadSettings])

  const handleSaveGlobal = async () => {
    const n = Math.max(0, Math.min(20, Math.floor(Number(globalAiDraft) || 0)))
    setSavingGlobal(true)
    const r = await saveSettings({ aiConcurrency: n })
    setSavingGlobal(false)
    if (r.ok && r.value.ok) {
      setGlobalAiDraft(String(r.value.value.aiConcurrency))
      setToast(t('toast.saved'))
    } else {
      setToast(t('toast.failed'))
    }
  }

  const refresh = useCallback(async () => {
    const [jr, sr, cr, mr, kr] = await Promise.all([
      listJobs({}), listPveServers({}), listChannels({}), listModels({}), listSkills({}),
    ])
    if (jr.ok && jr.value.ok) setJobs([...jr.value.value.jobs])
    if (sr.ok && sr.value.ok) setServers([...sr.value.value.servers])
    if (cr.ok && cr.value.ok) setChannels([...cr.value.value.channels])
    if (mr.ok && mr.value.ok) setModelGroups([...mr.value.value.groups])
    if (kr.ok && kr.value.ok) setSkills([...kr.value.value.skills])
  }, [listJobs, listPveServers, listChannels, listModels, listSkills])

  useEffect(() => {
    void refresh()
    // Auto-refresh so run logs / statuses update while the page stays open
    // (fires, AI analysis, and pushes all happen server-side asynchronously).
    const timer = setInterval(() => { void refresh() }, 10_000)
    return () => clearInterval(timer)
  }, [refresh])

  const serverName = (id: string): string => servers.find(s => s.id === id)?.name ?? id
  const typeLabel = (type: 'pve' | 'agent'): string => type === 'pve' ? t('type.pve') : t('type.agent')

  const openAdd = () => { setPickOpen(true) }
  const pickType = (type: 'pve' | 'agent') => {
    setPickOpen(false)
    setDraft(emptyDraft(type))
    setModalOpen(true)
  }
  const openEdit = (job: SchedulerJob) => {
    setDraft({
      id: job.id, name: job.name, type: job.type, cron: job.cron, enabled: job.enabled,
      pveServerId: job.pveServerId, aiEnabled: job.aiEnabled,
      prompt: job.prompt,
      skillName: job.skillName,
      model: job.model === null ? '' : `${job.model.provider}::${job.model.model}`,
      channelIds: [...job.channelIds],
    })
    setModalOpen(true)
  }
  const closeModal = () => { setModalOpen(false) }

  const handleSave = async () => {
    console.log('[scheduler] handleSave draft:', JSON.stringify({ ...draft, id: draft.id }))
    if (draft.name.trim().length === 0 || draft.cron.trim().length === 0) {
      console.warn('[scheduler] save blocked: name or cron empty', { name: draft.name, cron: draft.cron })
      setToast(t('toast.failed'))
      return
    }
    if (draft.type === 'pve' && draft.pveServerId.trim().length === 0) {
      console.warn('[scheduler] save blocked: pve server not selected')
      setToast(t('toast.failed'))
      return
    }
    if (draft.type === 'agent' && draft.prompt.trim().length === 0) {
      console.warn('[scheduler] save blocked: agent prompt empty')
      setToast(t('toast.failed'))
      return
    }
    if (draft.type === 'pve' && draft.aiEnabled && draft.prompt.trim().length === 0) {
      console.warn('[scheduler] save blocked: pve ai prompt empty')
      setToast(t('toast.failed'))
      return
    }
    if (draft.channelIds.length === 0) {
      console.warn('[scheduler] save blocked: no channel selected')
      setToast(t('toast.failed'))
      return
    }
    const [provider = '', model = ''] = draft.model.split('::')
    const input: SchedulerJobInput = {
      id: draft.id.trim().length === 0 ? crypto.randomUUID() : draft.id.trim(),
      name: draft.name.trim(),
      type: draft.type,
      cron: draft.cron.trim(),
      enabled: draft.enabled,
      pveServerId: draft.type === 'pve' ? draft.pveServerId.trim() : '',
      aiEnabled: draft.type === 'pve' ? draft.aiEnabled : false,
      prompt: draft.prompt.trim(),
      skillName: draft.skillName.trim(),
      model: provider === '' ? null : { provider, model },
      channelIds: draft.channelIds,
    }
    console.log('[scheduler] saving job:', JSON.stringify(input))
    const r = await saveJob({ input })
    console.log('[scheduler] saveJob response:', JSON.stringify(r))
    if (r.ok && r.value.ok) {
      closeModal()
      setToast(t('toast.saved'))
      await refresh()
    } else if (r.ok && !r.value.ok) {
      setToast(`${r.value.error.code}: ${r.value.error.message}`)
    } else if (!r.ok) {
      setToast(`${r.error.code}: ${r.error.message}`)
    }
  }

  const confirmDelete = async () => {
    if (deleteTarget === null) return
    const r = await deleteJob({ id: deleteTarget.id })
    if (r.ok && r.value.ok) {
      setDeleteTarget(null)
      setToast(t('toast.deleted'))
      await refresh()
    }
  }

  const toggleEnabled = async (job: SchedulerJob) => {
    const r = await setEnabled({ id: job.id, enabled: !job.enabled })
    if (r.ok && r.value.ok) await refresh()
  }

  const handleRunNow = async (job: SchedulerJob) => {
    setRunningId(job.id)
    const r = await runNow({ id: job.id })
    setRunningId(null)
    if (r.ok && r.value.ok) {
      setToast(t('toast.ran'))
      setTimeout(() => { void refresh() }, 2500)
    } else {
      setToast(t('toast.failed'))
    }
  }

  const toggleChannel = (id: string, on: boolean) => {
    setDraft(d => ({ ...d, channelIds: on ? [...d.channelIds, id] : d.channelIds.filter(c => c !== id) }))
  }

  const modelValueOf = (ref: SchedulerModelRef): string => `${ref.provider}::${ref.model}`

  return (
    <div className={css.panel}>
      <div className={css.panelHeader}>
        <div className={css.titleWrap}>
          <h3 className={css.title}>{t('title')}</h3>
          <span className={css.subtitle}>{t('subtitle')}</span>
        </div>
        <Button variant="outline" size="sm" onClick={openAdd}>{t('action.add')}</Button>
      </div>

      {/* Module-level global AI concurrency control */}
      <div className={css.globalBar}>
        <span className={css.globalLabel}>{t('global.aiConcurrency')}</span>
        <input type="number" min={0} max={20} className={css.cronInput} style={{ width: 80 }}
          aria-label={t('global.aiConcurrency')}
          value={globalAiDraft}
          onChange={e => setGlobalAiDraft(e.target.value)} />
        <Button variant="primary" size="sm" disabled={savingGlobal} onClick={() => void handleSaveGlobal()}>
          {t('action.save')}
        </Button>
        <span className={css.globalHint}>{t('global.hint')}</span>
      </div>

      {jobs.length === 0 ? (
        <div className={css.empty}>{t('list.empty')}</div>
      ) : (
        <ul className={css.list}>
          {jobs.map(job => (
            <li key={job.id} className={css.item}>
              <div className={css.itemMain}>
                <div className={css.itemTop}>
                  <span className={css.itemName}>{job.name}</span>
                  <span className={css.typeBadge}>{typeLabel(job.type)}</span>
                  <span className={css.cronBadge}>{job.cron}</span>
                  {job.enabled
                    ? <StateDot state="done" />
                    : <StateDot state="warning" />}
                </div>
                <div className={css.itemMeta}>
                  {job.type === 'pve' && <span className={css.metaTarget}>PVE · {serverName(job.pveServerId)}</span>}
                  {job.channelIds.length > 0 && (
                    <span className={css.metaTarget}>{t('field.channels')} {job.channelIds.length}</span>
                  )}
                  <span className={css.metaTime}>{t('state.next')} {formatTime(job.nextRunAt, t)}</span>
                  <span className={css.metaTime}>{t('state.last')} {formatTime(job.lastRunAt, t)}</span>
                  {job.lastStatus !== null && (
                    <span className={job.lastStatus === 'ok' ? css.lastOk : css.lastError}>
                      {job.lastStatus === 'ok' ? t('status.ok') : t('status.error')}{job.lastMessage ? ` · ${job.lastMessage}` : ''}
                    </span>
                  )}
                </div>
              </div>
              <div className={css.itemActions}>
                <label className={css.switch}>
                  <input type="checkbox" checked={job.enabled} onChange={() => void toggleEnabled(job)} />
                  <span className={css.switchTrack} />
                </label>
                <Button variant="ghost" size="sm" disabled={runningId === job.id} onClick={() => void handleRunNow(job)}>
                  {runningId === job.id ? t('action.running') : t('action.runNow')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openEdit(job)}>{t('action.edit')}</Button>
                <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(job)}>{t('action.delete')}</Button>
                <Button variant="ghost" size="sm" onClick={() => setLogModalJob(job)}>{t('action.runlog')}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Type picker */}
      <Modal open={pickOpen} onClose={() => setPickOpen(false)} title={t('pick.title')}
        closeLabel={t('action.close')}
        footer={(<Button variant="ghost" onClick={() => setPickOpen(false)}>{t('action.cancel')}</Button>)}>
        <p className={css.pickHint}>{t('pick.hint')}</p>
        <div className={css.pickGrid}>
          <button type="button" className={css.pickCard} onClick={() => pickType('pve')}>
            <span className={css.pickTitle}>{t('type.pve')}</span>
            <span className={css.pickDesc}>{t('type.pve.desc')}</span>
          </button>
          <button type="button" className={css.pickCard} onClick={() => pickType('agent')}>
            <span className={css.pickTitle}>{t('type.agent')}</span>
            <span className={css.pickDesc}>{t('type.agent.desc')}</span>
          </button>
        </div>
      </Modal>

      {/* Add / edit form */}
      <Modal open={modalOpen} onClose={closeModal} title={draft.id === '' ? t('action.add') : t('action.edit')}
        closeLabel={t('action.close')}
        contentClassName={css.modalContent ?? ''}
        footer={(<><Button variant="ghost" onClick={closeModal}>{t('action.cancel')}</Button>
          <Button variant="primary" onClick={() => void handleSave()}>{t('action.save')}</Button></>)}>
        <div className={css.form}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('field.name')}<Req /></span>
            <Input aria-label={t('field.name')} placeholder={draft.type === 'pve' ? 'PVE 5分钟采集' : '日报推送'} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('field.cron')}<Req /></span>
            <CronBuilder t={t} value={draft.cron} onChange={cron => setDraft({ ...draft, cron })} />
            <span className={css.fieldHint}>{t('field.cronHint')}</span>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('field.enabled')}</span>
            <label className={css.switch}>
              <input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />
              <span className={css.switchTrack} />
            </label>
          </label>

          {draft.type === 'pve' && (
            <>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('field.server')}<Req /></span>
                <select className={css.select} value={draft.pveServerId}
                  onChange={e => setDraft({ ...draft, pveServerId: e.target.value })}>
                  <option value="">{servers.length === 0 ? '—' : '…'}</option>
                  {servers.map(s => <option key={s.id} value={s.id}>{s.name}（{s.id}）</option>)}
                </select>
              </label>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('field.aiEnabled')}</span>
                <div className={css.radioGroup}>
                  <label className={css.inlineToggle}>
                    <input type="radio" name="sched-ai" checked={draft.aiEnabled} onChange={() => setDraft({ ...draft, aiEnabled: true })} />
                    <span>{t('option.yes')}</span>
                  </label>
                  <label className={css.inlineToggle}>
                    <input type="radio" name="sched-ai" checked={!draft.aiEnabled} onChange={() => setDraft({ ...draft, aiEnabled: false })} />
                    <span>{t('option.no')}</span>
                  </label>
                </div>
              </label>
            </>
          )}

          {draft.type === 'agent' && (
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('field.prompt')}<Req /></span>
              <textarea className={css.textarea} rows={3} aria-label={t('field.prompt')}
                placeholder="定时向 agent 下发的指令，例如：汇总所有 PVE 服务器今天的失败任务并输出简报"
                value={draft.prompt} onChange={e => setDraft({ ...draft, prompt: e.target.value })} />
            </label>
          )}

          {draft.type === 'pve' && draft.aiEnabled && (
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('field.prompt')}<Req /></span>
              <textarea className={css.textarea} rows={3} aria-label={t('field.prompt')}
                placeholder="AI 分析引导，例如：分析这批失败任务，指出可能的原因和处置建议"
                value={draft.prompt} onChange={e => setDraft({ ...draft, prompt: e.target.value })} />
            </label>
          )}

          <div className={css.field}>
            <span className={css.fieldLabel}>{t('field.skill')}</span>
            <button type="button" className={css.skillPickButton} onClick={() => setSkillPickOpen(true)}>
              {draft.skillName.trim() === ''
                ? t('field.skillHint')
                : `✓ ${draft.skillName}`}
            </button>
            {draft.skillName.trim() !== '' && (
              <button type="button" className={css.skillClear} onClick={() => setDraft({ ...draft, skillName: '' })}>
                {t('action.delete')}
              </button>
            )}
          </div>

          <label className={css.field}>
            <span className={css.fieldLabel}>{t('field.model')}</span>
            <select className={css.select} value={draft.model}
              onChange={e => setDraft({ ...draft, model: e.target.value })}>
              <option value="">{t('state.never') === '从未' ? '默认模型' : 'Default model'}</option>
              {modelGroups.flatMap(g => g.models.map(m => (
                <option key={modelValueOf(m)} value={modelValueOf(m)}>{g.name} / {m.model}</option>
              )))}
            </select>
          </label>

          <div className={css.field}>
            <span className={css.fieldLabel}>{t('field.channels')}<Req /></span>
            {channels.length === 0 ? (
              <div className={css.hint}>{t('field.channelsNone')}</div>
            ) : (
              <div className={css.channelGroups}>
                {channelGroupTypes(channels).map(type => {
                  const group = channels.filter(c => c.type === type)
                  if (group.length === 0) return null
                  return (
                    <div key={type} className={css.channelGroup}>
                      <div className={css.channelGroupLabel}>{channelTypeLabel(type, t)}</div>
                      <div className={css.channelGrid}>
                        {group.map(c => (
                          <label key={c.id} className={css.channelToggle}>
                            <input type="checkbox" checked={draft.channelIds.includes(c.id)} onChange={e => toggleChannel(c.id, e.target.checked)} />
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
        </div>
      </Modal>

      {/* Skill picker: card window, not a dropdown */}
      <Modal open={skillPickOpen} onClose={() => setSkillPickOpen(false)} title={t('field.skill')}
        closeLabel={t('action.close')}
        contentClassName={css.modalContent ?? ''}
        footer={(<Button variant="ghost" onClick={() => setSkillPickOpen(false)}>{t('action.cancel')}</Button>)}>
        <div className={css.skillGrid}>
          {skills.length === 0 && <div className={css.hint}>{t('list.empty')}</div>}
          {skills.map(skill => (
            <button key={skill.name} type="button"
              className={`${css.skillCard} ${draft.skillName === skill.name ? css.skillCardActive : ''}`}
              onClick={() => { setDraft({ ...draft, skillName: skill.name }); setSkillPickOpen(false) }}>
              <span className={css.skillCardName}>{skill.name}</span>
              <span className={css.skillCardDesc}>{skill.description}</span>
            </button>
          ))}
        </div>
      </Modal>

      {/* Run-log viewer: pop-up, not inline on the card */}
      <Modal open={logModalJob !== null} onClose={() => setLogModalJob(null)}
        title={`${t('runlog.title')}${logModalJob !== null ? ` · ${logModalJob.name}` : ''}`}
        closeLabel={t('action.close')}
        contentClassName={css.modalContent ?? ''}
        footer={(<Button variant="ghost" onClick={() => setLogModalJob(null)}>{t('action.cancel')}</Button>)}>
        {logModalJob !== null && (
          <div className={css.runlog}>
            <div className={css.runlogHeader}>
              <span className={css.runlogTitle}>{t('runlog.show')}</span>
              <select className={css.runlogSelect} value={String(logLimits[logModalJob.id] ?? 10)}
                onChange={e => setLogLimits(prev => ({ ...prev, [logModalJob.id]: Number(e.target.value) }))}>
                <option value="5">5 {t('runlog.count')}</option>
                <option value="10">10 {t('runlog.count')}</option>
                <option value="20">20 {t('runlog.count')}</option>
                <option value="50">50 {t('runlog.count')}</option>
                <option value="200">200 {t('runlog.count')}</option>
              </select>
            </div>
            {logModalJob.runLogs.length === 0 ? (
              <div className={css.runlogEmpty}>{t('runlog.empty')}</div>
            ) : (
              <ul className={css.runlogList}>
                {logModalJob.runLogs.slice(0, logLimits[logModalJob.id] ?? 10).map((log, i) => (
                  <li key={i} className={css.runlogItem}>
                    <span className={log.status === 'ok' ? css.runlogOk : css.runlogError}>
                      {log.status === 'ok' ? t('status.ok') : t('status.error')}
                    </span>
                    <span className={css.runlogTime}>{formatTime(log.at, t)}</span>
                    <span className={css.runlogMsg}>{log.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Modal>

      <Modal open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title={t('delete.title')}
        closeLabel={t('action.close')}
        footer={(<><Button variant="ghost" onClick={() => setDeleteTarget(null)}>{t('action.cancel')}</Button>
          <Button variant="primary" onClick={() => void confirmDelete()}>{t('action.delete')}</Button></>)}>
        <p>{t('delete.confirm')}</p>
      </Modal>

      {toast !== null && <Toast text={toast} onDone={() => setToast(null)} />}
    </div>
  )
}
