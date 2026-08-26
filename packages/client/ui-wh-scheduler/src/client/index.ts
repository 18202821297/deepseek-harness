import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SchedulerConfig } from './Scheduler.tsx'
import type { SchedulerInjected } from './Scheduler.tsx'
import { en, zh, type SchedulerKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { whScheduler: SchedulerKey }
}
const NS = 'whScheduler'
export const inject = ['slots', 'locale', 'remote', 'remote.scheduler']

export type SchedulerProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'whScheduler'>
  & InjectFace<SchedulerInjected>

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-wh-scheduler: dictionaries')
  const t = ctx.locale.bind(NS)
  const injected = (): SchedulerInjected => ({
    listJobs: request => ctx.remote.scheduler.listJobs(request),
    saveJob: request => ctx.remote.scheduler.saveJob(request),
    deleteJob: request => ctx.remote.scheduler.deleteJob(request),
    setEnabled: request => ctx.remote.scheduler.setEnabled(request),
    runNow: request => ctx.remote.scheduler.runNow(request),
    getSettings: request => ctx.remote.scheduler.getSettings(request),
    saveSettings: request => ctx.remote.scheduler.saveSettings(request),
    listPveServers: request => ctx.remote.scheduler.listPveServers(request),
    listChannels: request => ctx.remote.scheduler.listChannels(request),
    listModels: request => ctx.remote.scheduler.listModels(request),
    listSkills: request => ctx.remote.scheduler.listSkills(request),
  })
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'wh-scheduler',
    order: 40,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, SchedulerConfig))
}
