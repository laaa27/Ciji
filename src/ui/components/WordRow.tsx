import styles from './WordRow.module.css'

export type WordState = 'new' | 'vague' | 'forget'

type Props = {
  spelling: string
  gloss?: string
  state: WordState
  /** 形如「初模糊 → 终认识」，仅当首末反馈不一致时传入 */
  note?: string
}

export default function WordRow({ spelling, gloss, state, note }: Props) {
  return (
    <li className={styles.row} data-state={state}>
      <div className={styles.head}>
        <span className={styles.word}>{spelling}</span>
        {note && <span className={styles.note}>{note}</span>}
      </div>
      {gloss !== undefined ? (
        <p className={styles.gloss}>{gloss || '—'}</p>
      ) : (
        <p className={styles.gloss} data-pending="true">
          查询中
        </p>
      )}
    </li>
  )
}
