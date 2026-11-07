import styles from './WordRow.module.css'

export type WordState = 'new' | 'vague' | 'forget'

type Props = {
  spelling: string
  gloss?: string
  state: WordState
  /** 形如「初模糊 → 终认识」，仅当首末反馈不一致时传入 */
  note?: string
  /**
   * 释义是否可见。不传则始终显示。
   * 今日页传了它，配合 onToggle 实现「先回想、再点开」。
   */
  glossVisible?: boolean
  onToggle?: () => void
}

export default function WordRow({
  spelling,
  gloss,
  state,
  note,
  glossVisible,
  onToggle,
}: Props) {
  // 没有释义时不给点击反馈，否则点了没反应反而困惑
  const interactive = typeof onToggle === 'function' && Boolean(gloss)
  const visible = glossVisible ?? true

  return (
    <li
      className={styles.row}
      data-state={state}
      data-interactive={interactive}
      onClick={interactive ? onToggle : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onToggle?.()
              }
            }
          : undefined
      }
    >
      <div className={styles.head}>
        <span className={styles.word}>{spelling}</span>
        {note && <span className={styles.note}>{note}</span>}
      </div>

      {gloss ? (
        visible ? (
          <p className={styles.gloss}>{gloss}</p>
        ) : (
          <span className={styles.folded} aria-label="点一下查看释义" />
        )
      ) : null}
    </li>
  )
}
