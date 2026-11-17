import type { ReactNode } from 'react'

import type { ChainSlot, TrainingQuestion } from '@/domain/training'

import styles from './TrainingDoc.module.css'

type Props = {
  chain: ChainSlot[]
  answers: Record<number, string>
  submitted: boolean
  questions: TrainingQuestion[]
  /** 当前选中的槽位（题号）；null 表示没在填 */
  activeSlot: number | null
  onSlot: (no: number) => void
}

/** 排序题链图：按原卷给定的段落顺序排布，灰盒 = 已给定，可点盒子 = 待答槽位。 */
export function OrderChain({ chain, answers, submitted, questions, activeSlot, onSlot }: Props) {
  const nodes: ReactNode[] = []
  chain.forEach((slot, i) => {
    if (i > 0) {
      nodes.push(
        <span key={`a${i}`} className={styles.chainArrow} aria-hidden="true">
          →
        </span>,
      )
    }
    if (slot.given) {
      nodes.push(
        <span key={`g${i}`} className={styles.chainItem}>
          <span className={`${styles.chainBox} ${styles.chainGiven}`}>{slot.given}</span>
          <span className={styles.chainCap}>原卷已给定</span>
        </span>,
      )
      return
    }
    const no = slot.no as number
    const q = questions.find((x) => x.no === no)
    const chosen = answers[no]
    const right = submitted && chosen && chosen === q?.answer
    const wrong = submitted && chosen && chosen !== q?.answer
    nodes.push(
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
      </span>,
    )
  })
  return <div className={styles.chain}>{nodes}</div>
}
