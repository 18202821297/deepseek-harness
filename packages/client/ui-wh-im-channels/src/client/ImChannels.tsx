import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DingtalkConfig } from './DingtalkConfig.tsx'
import type { DingtalkConfigProps } from './DingtalkConfig.tsx'
import type { ImChannelsProps } from './index.ts'
import css from './ImChannels.module.css'

interface ProviderDef {
  id: 'dingtalk' | 'feishu'
  name: string
  available: boolean
}

/** Left-side entries. To add a provider: add a row here + a panel component. */
const PROVIDERS: ProviderDef[] = [
  { id: 'dingtalk', name: '钉钉', available: true },
  { id: 'feishu', name: '中国飞书', available: false },
]

/** Component props: runtime + locale + injected verbs (see DingtalkConfigProps). */
export type { ImChannelsInjected } from './DingtalkConfig.tsx'
export type ImChannelsComponentProps = ImChannelsProps

export function ImChannels(props: ImChannelsProps) {
  const [selected, setSelected] = useState<'dingtalk' | 'feishu'>('dingtalk')
  const title = selected === 'feishu' ? props.t('title.feishu') : props.t('title.dingtalk')

  return (
    <div className={css.shell}>
      <aside className={css.sidebar}>
        {PROVIDERS.map(p => (
          <button
            key={p.id}
            type="button"
            className={`${css.navItem} ${selected === p.id ? css.navItemActive : ''}`}
            disabled={!p.available}
            onClick={() => setSelected(p.id)}
          >
            <span>{p.name}</span>
            {!p.available && <span className={css.navBadge}>未接入</span>}
          </button>
        ))}
      </aside>
      <main className={css.main}>
        <h3 className={css.pageTitle}>{title}</h3>
        {selected === 'dingtalk' && <DingtalkConfig {...(props as unknown as DingtalkConfigProps)} />}
        {selected === 'feishu' && (
          <div className={css.placeholder}>
            <div className={css.placeholderTitle}>中国飞书</div>
            <div>暂未接入，敬请期待。</div>
            <Button variant="ghost" disabled>配置飞书</Button>
          </div>
        )}
      </main>
    </div>
  )
}
