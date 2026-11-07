import styles from './TabBar.module.css'

export type TabKey = 'today' | 'history' | 'reading' | 'stats' | 'settings'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'history', label: '历史' },
  { key: 'reading', label: '阅读' },
  { key: 'stats', label: '统计' },
  { key: 'settings', label: '设置' },
]

type Props = {
  value: TabKey
  onChange: (key: TabKey) => void
}

export default function TabBar({ value, onChange }: Props) {
  return (
    <nav className={styles.bar} aria-label="主导航">
      {TABS.map((tab) => {
        const active = tab.key === value
        return (
          <button
            key={tab.key}
            type="button"
            className={styles.item}
            data-active={active}
            onClick={() => onChange(tab.key)}
            aria-current={active ? 'page' : undefined}
          >
            <span className={styles.label}>{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
