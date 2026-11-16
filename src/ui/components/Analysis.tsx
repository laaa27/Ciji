import type { TrainingQuestion } from '@/domain/training'

import styles from './TrainingDoc.module.css'

/**
 * 逐题解析：判定、判型 / 拆句 / 定位三行、逐选项判定、补充说明。
 *
 * 选择题在答题条内展开，选词填空在逐空列表里以紧凑形态展开（compact）。
 */
export function Analysis({
  q,
  picked,
  compact,
}: {
  q: TrainingQuestion
  picked?: string
  compact?: boolean
}) {
  const an = q.analysis
  const ok = picked === q.answer
  if (!an) {
    return (
      <div className={styles.analysis} data-compact={compact ? 'true' : undefined}>
        <p className={styles.anRow}>这道题没有解析。</p>
      </div>
    )
  }
  return (
    <div className={styles.analysis} data-compact={compact ? 'true' : undefined}>
      <p className={styles.anVerdict} data-right={ok ? 'true' : 'false'}>
        {ok ? '答对了' : `正确答案 ${q.answer ?? '—'}`}
        {an.qtype ? ` · ${an.qtype}` : ''}
      </p>
      {an.judge && (
        <p className={styles.anRow}>
          <span className={styles.anKey}>判型</span>
          <span className={styles.anBody}>{an.judge}</span>
        </p>
      )}
      {an.split && (
        <p className={styles.anRow}>
          <span className={styles.anKey}>拆句</span>
          <span className={styles.anBody}>{an.split}</span>
        </p>
      )}
      {an.locate && (
        <p className={styles.anRow}>
          <span className={styles.anKey}>定位</span>
          <span className={styles.anBody}>{an.locate}</span>
        </p>
      )}
      {(an.options ?? []).length > 0 && (
        <ul className={styles.anOpts}>
          {(an.options ?? []).map((o) => (
            <li key={o.key} data-right={o.verdict.includes('正确') ? 'true' : undefined}>
              <div className={styles.anOptHead}>
                <span className={styles.anOptKey}>{o.key}</span>
                <span className={styles.anOptVerdict}>{o.verdict}</span>
              </div>
              {o.note && <p className={styles.anOptNote}>{o.note}</p>}
            </li>
          ))}
        </ul>
      )}
      {an.note && <p className={styles.anRow}>{an.note}</p>}
      {an.raw && <p className={styles.anRow}>{an.raw}</p>}
    </div>
  )
}
