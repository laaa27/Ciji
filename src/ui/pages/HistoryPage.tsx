import EmptyState from '../components/EmptyState'
import styles from './Placeholder.module.css'

export default function HistoryPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>历史</h1>
      <EmptyState title="还没有记录" hint="每天打开一次，这里会按日期攒下你的词。" />
    </div>
  )
}
