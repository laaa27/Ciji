import type { TrainingQuestion } from '@/domain/training'

import { Analysis } from './Analysis'
import styles from './TrainingDoc.module.css'

type Props = {
  /** 候选字母全集（段落 A–G 标号） */
  pool: string[]
  /** 原卷已给定的字母 —— 候选里不出现 */
  given: string[]
  answers: Record<number, string>
  submitted: boolean
  /** 当前选中的槽位（题号）；null 表示没在填，候选区显示提示 */
  activeSlot: number | null
  onPick: (no: number, key: string) => void
  onSubmit: () => void
  answeredCount: number
  total: number
  rightCount: number
  judgedCount: number
  collapsed: boolean
  onToggle: () => void
}

/** 排序题吸底候选条：点槽位后弹出候选字母，滑到哪都能点。 */
export function OrderingBar({
  pool,
  given,
  answers,
  submitted,
  activeSlot,
  onPick,
  onSubmit,
  answeredCount,
  total,
  rightCount,
  judgedCount,
  collapsed,
  onToggle,
}: Props) {
  const candidates = pool.filter((k) => !given.includes(k))
  return (
    <div
      className={styles.qbar}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-compact="true"
    >
      <div className={styles.qbarHead}>
        <span className={styles.qbarTitle}>段落排序</span>
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
        <div className={styles.qbarBody}>
          {submitted ? (
            <p className={styles.qbarScore}>
              已提交 · 答对 {rightCount} / {judgedCount}
              {answeredCount < total ? `（${total - answeredCount} 题未答）` : ''}
            </p>
          ) : activeSlot == null ? (
            <p className={styles.stem}>点击链图中的虚线槽位，从下方候选中选择段落字母</p>
          ) : (
            <p className={styles.stem}>
              <span className={styles.qNo}>{activeSlot}</span>
              选择该位置的段落字母
            </p>
          )}

          {activeSlot != null && !submitted && (
            <ul className={styles.letters}>
              {candidates.map((k) => {
                const chosen = answers[activeSlot] === k
                const usedElsewhere = Object.entries(answers).some(
                  ([no, v]) => v === k && Number(no) !== activeSlot,
                )
                return (
                  <li key={k}>
                    <button
                      type="button"
                      className={styles.letter}
                      data-state={chosen ? 'chosen' : undefined}
                      data-used={usedElsewhere ? 'true' : undefined}
                      disabled={submitted}
                      onClick={() => onPick(activeSlot, k)}
                    >
                      {k}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

/** 提交后逐槽的结果：你的答案、正确答案、可展开的解析（与完形结果同一模式） */
export function OrderResult({
  questions,
  answers,
  open,
  onOpen,
}: {
  questions: TrainingQuestion[]
  answers: Record<number, string>
  open: number | null
  onOpen: (no: number | null) => void
}) {
  return (
    <ul className={styles.blankList}>
      {questions.map((q) => {
        const ok = answers[q.no] === q.answer
        const isOpen = open === q.no
        return (
          <li key={q.no}>
            <button
              type="button"
              className={styles.blankRow}
              onClick={() => onOpen(isOpen ? null : q.no)}
            >
              <span className={styles.qNo}>{q.no}</span>
              <span data-ok={ok ? 'true' : 'false'}>
                {answers[q.no] ?? '未答'}
                {ok ? ' ✓' : ` · 正确 ${q.answer ?? '—'}`}
              </span>
              <span className={styles.blankMore}>{isOpen ? '收起' : '解析'}</span>
            </button>
            {isOpen && <Analysis q={q} picked={answers[q.no]} compact />}
          </li>
        )
      })}
    </ul>
  )
}
