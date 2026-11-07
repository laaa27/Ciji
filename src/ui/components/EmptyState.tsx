import styles from './EmptyState.module.css'

type Props = {
  title: string
  hint?: string
}

export default function EmptyState({ title, hint }: Props) {
  return (
    <div className={styles.wrap}>
      <p className={styles.title}>{title}</p>
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  )
}
