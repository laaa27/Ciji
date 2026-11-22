import { KIND_LABEL, type WordCandidate, type WordKind } from '@/domain/article'

import styles from '../GenerateArticle.module.css'

/**
 * 一组词（「将使用」或「不使用」）。
 *
 * 原先这两组的 JSX 在生成页里逐行重复，只差 `data-on` 和一个点击回调；
 * 合成一个组件用 `on` 区分，三处（勾选态、已用标记、类型说明）以后只改一处。
 */

const KIND_COLOR: Record<WordKind, string> = {
  forget: 'var(--state-forget)',
  vague: 'var(--state-vague)',
  new: 'var(--state-new)',
}

export default function WordPickList({
  title,
  items,
  on,
  onToggle,
}: {
  title: string
  items: WordCandidate[]
  /** true = 将使用，false = 不使用 */
  on: boolean
  onToggle: (c: WordCandidate) => void
}) {
  if (items.length === 0) return null

  return (
    <section className={styles.group}>
      <h2 className={styles.groupHead}>
        {title} <span className={styles.groupCount}>{items.length}</span>
      </h2>
      <ul>
        {items.map((c) => (
          <li key={c.spelling}>
            <button
              type="button"
              className={styles.word}
              data-on={on ? 'true' : 'false'}
              onClick={() => onToggle(c)}
            >
              <span className={styles.marks}>
                {c.kinds.map((k) => (
                  <span key={k} className={styles.mark} style={{ background: KIND_COLOR[k] }} />
                ))}
              </span>
              <span className={styles.spelling}>{c.spelling}</span>
              {c.used && <span className={styles.used}>已用</span>}
              <span className={styles.kindsText}>
                {c.kinds.map((k) => KIND_LABEL[k]).join(' / ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
