import type { TrainingOption, TrainingQuestion } from '@/domain/training'

import { Analysis } from './Analysis'
import styles from './TrainingDoc.module.css'

type Props = {
  bank: TrainingOption[]
  usedBy: Map<string, number>
  submitted: boolean
  answered: number
  total: number
  right: number
  collapsed: boolean
  onToggle: () => void
  onFill: (key: string) => void
  onSubmit: () => void
}

/** 选词填空的浮动词库：与选项条同一副壳子，滑到文章任何位置都能点词 */
export function ClozeBar({
  bank,
  usedBy,
  submitted,
  answered,
  total,
  right,
  collapsed,
  onToggle,
  onFill,
  onSubmit,
}: Props) {
  return (
    <div className={styles.qbar} data-collapsed={collapsed ? 'true' : 'false'}>
      <div className={styles.qbarHead}>
        <span className={styles.qbarTitle}>
          {submitted ? `已提交 · 答对 ${right} / ${total}` : `已答 ${answered} / ${total}`}
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
          <ul className={styles.bank}>
            {bank.map((b) => {
              const used = usedBy.get(b.key) !== undefined
              return (
                <li key={b.key}>
                  <button
                    type="button"
                    className={styles.chip}
                    data-used={used ? 'true' : 'false'}
                    disabled={submitted || used}
                    onClick={() => onFill(b.key)}
                  >
                    {b.text}
                  </button>
                </li>
              )
            })}
          </ul>

        </div>
      </div>
    </div>
  )
}

/** 提交后逐空的结果：你的答案、正确答案、可展开的解析 */
export function ClozeResult({
  questions,
  bank,
  answers,
  openBlank,
  onOpen,
}: {
  questions: TrainingQuestion[]
  bank: TrainingOption[]
  answers: Record<number, string>
  openBlank: number | null
  onOpen: (no: number | null) => void
}) {
  const wordOf = (key?: string) => (key ? bank.find((b) => b.key === key)?.text : undefined)

  return (
    <ul className={styles.blankList}>
      {questions.map((q) => {
        const ok = answers[q.no] === q.answer
        const open = openBlank === q.no
        return (
          <li key={q.no}>
            <button
              type="button"
              className={styles.blankRow}
              onClick={() => onOpen(open ? null : q.no)}
            >
              <span className={styles.qNo}>{q.no}</span>
              <span data-ok={ok ? 'true' : 'false'}>
                {answers[q.no] ? wordOf(answers[q.no]) ?? answers[q.no] : '未答'}
                {ok ? ' ✓' : ` · 正确 ${wordOf(q.answer) ?? q.answer ?? '—'}`}
              </span>
              <span className={styles.blankMore}>{open ? '收起' : '解析'}</span>
            </button>
            {open && <Analysis q={q} picked={answers[q.no]} compact />}
          </li>
        )
      })}
    </ul>
  )
}
