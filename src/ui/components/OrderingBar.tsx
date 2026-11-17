import type { ChainSlot, TrainingQuestion } from '@/domain/training'

import { Analysis } from './Analysis'
import styles from './TrainingDoc.module.css'

type Props = {
  chain: ChainSlot[]
  /** 候选字母全集（段落 A–G 标号） */
  pool: string[]
  answers: Record<number, string>
  submitted: boolean
  questions: TrainingQuestion[]
  /** 当前选中的槽位（题号）；null 表示没在填 */
  activeSlot: number | null
  onSlot: (no: number) => void
  onPick: (no: number, key: string) => void
  onSubmit: () => void
  answeredCount: number
  total: number
  rightCount: number
  judgedCount: number
  /** 提交后展开解析的槽位 */
  openResult: number | null
  onOpenResult: (no: number | null) => void
  collapsed: boolean
  onToggle: () => void
}

/**
 * 排序题吸底答题栏：链图、候选字母、解析全部在这一个栏里（与其他题型同壳）。
 * 灰盒 = 原卷已给定（候选里永不出现）；实线 = 已答；虚线 = 待答。
 */
export function OrderingBar({
  chain,
  pool,
  answers,
  submitted,
  questions,
  activeSlot,
  onSlot,
  onPick,
  onSubmit,
  answeredCount,
  total,
  rightCount,
  judgedCount,
  openResult,
  onOpenResult,
  collapsed,
  onToggle,
}: Props) {
  const given = chain.filter((c) => c.given).map((c) => c.given as string)
  const candidates = pool.filter((k) => !given.includes(k))

  return (
    <div
      className={styles.qbar}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-compact="true"
    >
      <div className={styles.qbarHead}>
        <span className={styles.qbarTitle}>
          {submitted
            ? `段落排序 · 答对 ${rightCount} / ${judgedCount}`
            : answeredCount > 0
              ? `段落排序 · 已答 ${answeredCount} / ${total}`
              : '段落排序'}
        </span>
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
          <div className={styles.chain}>
            {chain.map((slot, i) => {
              if (slot.given) {
                return (
                  <span key={`g${i}`} className={styles.chainItem}>
                    <span className={`${styles.chainBox} ${styles.chainGiven}`}>
                      {slot.given}
                    </span>
                    <span className={styles.chainCap}>原卷已给定</span>
                  </span>
                )
              }
              const no = slot.no as number
              const q = questions.find((x) => x.no === no)
              const chosen = answers[no]
              const right = submitted && chosen && chosen === q?.answer
              const wrong = submitted && chosen && chosen !== q?.answer
              return (
                <span key={no} className={styles.chainItem}>
                  <button
                    type="button"
                    className={styles.chainBox}
                    data-slot="true"
                    data-answered={chosen ? 'true' : 'false'}
                    data-active={activeSlot === no ? 'true' : 'false'}
                    data-right={right ? 'true' : wrong ? 'false' : undefined}
                    onClick={() => onSlot(no)}
                  >
                    <span className={styles.chainNo}>{no}</span>
                    <span className={styles.chainVal}>{chosen || '?'}</span>
                  </button>
                  <span className={styles.chainCap}>{chosen ? '已选择' : '待选择'}</span>
                </span>
              )
            })}
          </div>

          {submitted ? (
            <ul className={styles.blankList}>
              {questions.map((q) => {
                const ok = answers[q.no] === q.answer
                const isOpen = openResult === q.no
                return (
                  <li key={q.no}>
                    <button
                      type="button"
                      className={styles.blankRow}
                      onClick={() => onOpenResult(isOpen ? null : q.no)}
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
          ) : activeSlot == null ? (
            <p className={styles.stem}>点击链图中的虚线槽位，从下方候选中选择段落字母</p>
          ) : (
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
