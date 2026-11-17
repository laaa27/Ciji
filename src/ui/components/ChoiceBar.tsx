import type { TrainingOption, TrainingQuestion } from '@/domain/training'

import { Analysis } from './Analysis'
import styles from './TrainingDoc.module.css'

type Props = {
  q: TrainingQuestion
  current: number
  total: number
  answers: Record<number, string>
  submitted: boolean
  exclusive: boolean
  matchKeys: string[]
  usedLetters: Map<string, number>
  rightCount: number
  judgedCount: number
  answeredCount: number
  collapsed: boolean
  onToggle: () => void
  onPick: (no: number, key: string) => void
  onPrev: () => void
  onNext: () => void
  onSubmit: () => void
}

/** 浮在底栏上方的答题条：与词卡同一个位置关系，滑到文章任何位置都在 */
export function ChoiceBar({
  q,
  current,
  total,
  answers,
  submitted,
  exclusive,
  matchKeys,
  usedLetters,
  rightCount,
  judgedCount,
  answeredCount,
  collapsed,
  onToggle,
  onPick,
  onPrev,
  onNext,
  onSubmit,
}: Props) {
  const picked = answers[q.no]
  const options: TrainingOption[] =
    q.options && q.options.length > 0 ? q.options : matchKeys.map((k) => ({ key: k, text: '' }))

  return (
    <div
      className={styles.qbar}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-compact={exclusive ? 'true' : 'false'}
    >
      <div className={styles.qbarHead}>
        <span className={styles.qbarTitle}>
          第 {current + 1} / {total} 题
        </span>
        <div className={styles.qbarCenter}>
          <button
            type="button"
            className={styles.navArrow}
            disabled={current === 0}
            onClick={onPrev}
            aria-label="上一题"
          >
            <span className={styles.navChev} data-dir="left" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.navArrow}
            disabled={current >= total - 1}
            onClick={onNext}
            aria-label="下一题"
          >
            <span className={styles.navChev} data-dir="right" aria-hidden="true" />
          </button>
        </div>
        <div className={styles.qbarNav}>
          {!submitted && (
            <button type="button" className={styles.qbarSubmit} onClick={onSubmit}>
              提交
            </button>
          )}
          <button type="button" className={styles.navBtn} onClick={onToggle}>
            {collapsed ? '展开' : '收起'}
          </button>
        </div>
      </div>

      <div className={styles.bodyClip}>
        <div key={q.no} className={`${styles.qbarBody} ${styles.qSwitch}`}>
          <p className={styles.stem}>
            <span className={styles.qNo}>{q.no}</span>
            {q.stem ?? '（无书面题干）'}
          </p>

          {exclusive ? (
            <ul className={styles.letters}>
              {options.map((o) => {
                const chosen = picked === o.key
                const usedElsewhere = usedLetters.has(o.key) && usedLetters.get(o.key) !== q.no
                let state: string | undefined
                if (submitted) {
                  if (o.key === q.answer) state = 'right'
                  else if (chosen) state = 'wrong'
                } else if (chosen) state = 'chosen'
                return (
                  <li key={o.key}>
                    <button
                      type="button"
                      className={styles.letter}
                      data-state={state}
                      disabled={submitted || usedElsewhere}
                      onClick={() => onPick(q.no, o.key)}
                    >
                      {o.key}
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <ul className={styles.opts}>
              {options.map((o) => {
                const chosen = picked === o.key
                let state: string | undefined
                if (submitted) {
                  if (o.key === q.answer) state = 'right'
                  else if (chosen) state = 'wrong'
                } else if (chosen) state = 'chosen'
                return (
                  <li key={o.key}>
                    <button
                      type="button"
                      className={styles.opt}
                      data-state={state}
                      onClick={() => onPick(q.no, o.key)}
                    >
                      <span className={styles.optKey}>{o.key}</span>
                      {o.text && <span className={styles.optText}>{o.text}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {submitted && <Analysis q={q} picked={picked} />}

          {submitted && (
            <p className={styles.qbarScore}>
              已提交 · 答对 {rightCount} / {judgedCount}
              {answeredCount < total ? `（${total - answeredCount} 题未答）` : ''}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
