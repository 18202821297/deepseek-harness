import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings.plugins.tab slot declaration into scope.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { PveConfig } from './PveConfig.tsx'
import type { PveInjected } from './PveConfig.tsx'
import { en, zh, type PveKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    whPve: PveKey
  }
}
const NS = 'whPve'
export const inject = ['slots', 'locale', 'remote', 'remote.pve', 'remote.dingtalk']

export type PveProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'whPve'>
  & InjectFace<PveInjected>

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-wh-pve: dictionaries')
  const t = ctx.locale.bind(NS)
  const injected = (): PveInjected => ({
    listServers: input => ctx.remote.pve.listServers(input),
    saveServer: input => ctx.remote.pve.saveServer(input),
    deleteServer: input => ctx.remote.pve.deleteServer(input),
    setEnabled: input => ctx.remote.pve.setEnabled(input),
    setPushEnabled: input => ctx.remote.pve.setPushEnabled(input),
    collectNow: input => ctx.remote.pve.collectNow(input),
    collectTest: input => ctx.remote.pve.collectTest(input),
    listChannels: input => ctx.remote.dingtalk.listChannels(input),
    listModels: input => ctx.remote.pve.listModels(input),
  })
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'wh-pve',
    order: 30,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, PveConfig))
}
