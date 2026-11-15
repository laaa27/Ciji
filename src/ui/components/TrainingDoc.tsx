import { useMemo, useState } from 'react'

import {
  hasTranslation,
  isObjective,
  type TrainingPassage,
  type TrainingPaper,
  type TrainingQuestion,
  type TrainingSection,
} from '@/domain/training'
import { tokenize } from '@/lib/text'
import { usePrefs, type FontSize } from '@/store/prefs'

import WordSheet from './WordSheet'
import styles from './TrainingDoc.module.css'

const FONT_SIZES: { key: FontSize; label: string }[] = [
  { key: 's', label: '小' },
  { key: 'm', label: '中' },
  { key: 'l', label: '大' },
  { key: 'xl', label: '特大' },
]

type Props = {
  paper: TrainingPaper
  section: TrainingSection
  passage: TrainingPassage
  /** 第几篇（从 0 起），标题里显示 */
  index: number
}

/**
 * 做题界面：上半是文章（与阅读页同一套排版与点词），下半是题目。
 *
 * 为什么不做成「先做题、再看原文」的答题模式：真题阅读本来就是开卷读的，
 * 把原文藏起来只是制造紧张感；真正需要的是读的时候随手点词查、做完立刻看错在哪。
 */
export default function TrainingDoc({ paper, section, passage, index }: Props) {
  const fontSize = usePrefs((s) => s.readingFont)
  const showZhAvailable = useMemo(() => hasTranslation(passage), [passage])

  const [showZh, setShowZh] = useState(false)
  const [sizePanel, setSizePanel] = useState(false)
  const [sheetWord, setSheetWord] = useState<string | null>(null)
  /** 每题选了什么；有值就代表已作答，解析跟着展开 */
  const [picked, setPicked] = useState<Record<number, string>>({})
  /** 主动收起的解析 */
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({})

  const objective = passage.questions.filter(isObjective).length

  return (
    <div className={styles.doc} data-size={fontSize}>
      <div className={styles.toolbar}>
        <span className={styles.meta}>
          {section.label} · 第 {index + 1} 篇 · {passage.questions.length} 题
        </span>
        <div className={styles.actions}>
          {showZhAvailable && (
            <button
              type="button"
              className={styles.action}
              data-on={showZh}
              onClick={() => setShowZh((v) => !v)}
            >
              译文
            </button>
          )}
          <button
            type="button"
            className={styles.action}
            data-on={sizePanel}
            onClick={() => setSizePanel((v) => !v)}
          >
            字号
          </button>
        </div>
      </div>

      {sizePanel && (
        <div className={styles.sizePanel}>
          {FONT_SIZES.map((f) => (
            <button
              key={f.key}
              type="button"
              className={styles.segment}
              data-on={fontSize === f.key}
              onClick={() => usePrefs.getState().set('readingFont', f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {section.id === 'listening' && (
        <div className={styles.audioGap}>
          <p className={styles.audioTitle}>音频暂缺</p>
          <p className={styles.audioText}>
            这份题库包不含听力音频，先按原文与题目练习；原文已带逐句中译，可以当阅读来做。
          </p>
        </div>
      )}

      {passage.brief && <p className={styles.brief}>{passage.brief}</p>}

      <article className={styles.body}>
        {passage.paras.map((para, pi) => (
          <p key={pi} className={`${styles.para} ${styles.en}`}>
            {para.map((s, si) => {
              const parts = tokenize(s.en)
              return (
                <span key={si} data-sentence="true">
                  {s.label && <span className={styles.paraLabel}>{s.label}</span>}
                  {parts.map((part, j) =>
                    part.isWord ? (
                      <span key={j} className={styles.glue}>
                        <button
                          type="button"
                          className={styles.word}
                          onClick={() => setSheetWord(part.text)}
                        >
                          {part.text}
                        </button>
                        {part.tail}
                      </span>
                    ) : (
                      <span key={j}>{part.text}</span>
                    ),
                  )}
                  {showZh && s.zh && <span className={styles.zh}>{s.zh}</span>}{' '}
                </span>
              )
            })}
          </p>
        ))}
      </article>

      {(passage.notes ?? []).map((note, i) => (
        <p key={i} className={styles.note}>
          {note}
        </p>
      ))}

      <section className={styles.questions}>
        <h2 className={styles.qTitle}>
          {objective > 0 ? `题目 · ${objective} 题可判分` : `题目 · ${passage.questions.length} 题`}
        </h2>

        <ol className={styles.qList}>
          {passage.questions.map((q) => (
            <QuestionItem
              key={q.no}
              q={q}
              picked={picked[q.no]}
              collapsed={Boolean(collapsed[q.no])}
              onPick={(key) => setPicked((prev) => ({ ...prev, [q.no]: key }))}
              onToggle={() => setCollapsed((prev) => ({ ...prev, [q.no]: !prev[q.no] }))}
            />
          ))}
        </ol>
      </section>

      <p className={styles.foot}>题源：{paper.label}</p>

      {sheetWord && (
        <WordSheet
          word={sheetWord}
          onClose={() => setSheetWord(null)}
          onPick={(next) => setSheetWord(next)}
        />
      )}
    </div>
  )
}

function QuestionItem({
  q,
  picked,
  collapsed,
  onPick,
  onToggle,
}: {
  q: TrainingQuestion
  picked?: string
  collapsed: boolean
  onPick: (key: string) => void
  onToggle: () => void
}) {
  const canJudge = isObjective(q)
  const answered = Boolean(picked)
  const right = answered && picked === q.answer
  const open = answered && !collapsed
  const an = q.analysis

  return (
    <li className={styles.q}>
      <p className={styles.stem}>
        <span className={styles.qNo}>{q.no}</span>
        {q.stem ?? '（听力题：无书面题干，听音频作答）'}
      </p>

      {q.options && q.options.length > 0 && (
        <ul className={styles.opts}>
          {q.options.map((o) => {
            let state = ''
            if (answered) {
              if (o.key === q.answer && canJudge) state = 'right'
              else if (o.key === picked) state = 'wrong'
            }
            return (
              <li key={o.key}>
                <button
                  type="button"
                  className={styles.opt}
                  data-state={state || undefined}
                  disabled={answered}
                  onClick={() => onPick(o.key)}
                >
                  <span className={styles.optKey}>{o.key}</span>
                  <span className={styles.optText}>{o.text}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {answered && (
        <div className={styles.verdict} data-right={canJudge ? right : undefined}>
          {canJudge ? (right ? '答对了' : `答错了，正确答案是 ${q.answer}`) : '已选择'}
          <button type="button" className={styles.plainBtn} onClick={onToggle}>
            {open ? '收起解析' : '看解析'}
          </button>
        </div>
      )}

      {!answered && q.answer && (
        <details className={styles.answerFirst}>
          <summary>先看答案</summary>
          <p>
            正确答案 {q.answer}
            {q.source ? `（${q.source}）` : ''}
          </p>
        </details>
      )}

      {open && an && (
        <div className={styles.analysis}>
          {an.answer && (
            <p className={styles.anRow}>
              <span className={styles.anKey}>答案</span>
              {an.answer}
              {an.qtype ? ` · ${an.qtype}` : ''}
            </p>
          )}
          {an.judge && (
            <p className={styles.anRow}>
              <span className={styles.anKey}>判型</span>
              {an.judge}
            </p>
          )}
          {an.split && (
            <p className={styles.anRow}>
              <span className={styles.anKey}>拆句</span>
              {an.split}
            </p>
          )}
          {an.locate && (
            <div className={styles.anRow}>
              <span className={styles.anKey}>定位</span>
              <span className={styles.anBody}>{an.locate}</span>
            </div>
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
      )}
    </li>
  )
}
