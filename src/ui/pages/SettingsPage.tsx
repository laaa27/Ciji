import styles from './Placeholder.module.css'

export default function SettingsPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>设置</h1>
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-3)' }}>接口凭证与数据管理，稍后接入。</p>
    </div>
  )
}
