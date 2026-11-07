import EmptyState from '../components/EmptyState'
import styles from './Placeholder.module.css'

export default function StatsPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>统计</h1>
      <EmptyState
        title="数据还不够"
        hint="积累几天之后，这里会出现新学、模糊、忘记三条趋势线。"
      />
    </div>
  )
}
