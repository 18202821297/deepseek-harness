import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the Plugins-settings slot declaration ('settings.plugins.tab' in ui-settings' SlotMap) into scope.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ImChannels } from './ImChannels.tsx'
import type { ImChannelsInjected } from './ImChannels.tsx'
import { en, zh, type ImChannelsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    whImChannels: ImChannelsKey
  }
}
const NS = 'whImChannels'
export const inject = ['slots', 'locale', 'remote', 'remote.dingtalk']

export type ImChannelsProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'whImChannels'>
  & InjectFace<ImChannelsInjected>

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-wh-im-channels: dictionaries')
  const t = ctx.locale.bind(NS)
  const injected = (): ImChannelsInjected => ({
    listChannels: input => ctx.remote.dingtalk.listChannels(input),
    saveChannel: input => ctx.remote.dingtalk.saveChannel(input),
    deleteChannel: input => ctx.remote.dingtalk.deleteChannel(input),
    setEnabled: input => ctx.remote.dingtalk.setEnabled(input),
    sendText: input => ctx.remote.dingtalk.sendText(input),
    testChannel: input => ctx.remote.dingtalk.testChannel(input),
  })
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'wh-im-channels',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, ImChannels))
}
