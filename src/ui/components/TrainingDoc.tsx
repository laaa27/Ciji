import { useMemo, useState } from 'react'

import {
  BLANK_RE,
  hasTranslation,
  isCloze,
  isObjective,
  type TrainingOption,
  type TrainingPaper,
  type TrainingPassage,
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
  /** 第几篇（从 0 起） */
  index: number
}

/** 一段文字切成「普通文字 / 填空位」两种片段 */
type Chunk = { kind: 'text'; text: string } | { kind: 'blank'; no: number }

function splitBlanks(text: string): Chunk[] {
  const out: Chunk[] = []
  let last = 0
  const re = new RegExp(BLANK_RE.source, 'g')
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    out.push({ kind: 'blank', no: Number(m[1]) })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/**
 * 做题界面。
 *
 * 三条与阅读页不同的规则：
 * 1. 答完不立刻判对错 —— 全部答完点「提交答卷」才出答案与解析。当场判分等于边做边看答案，
 *    真题练习就没意义了。
 * 2. 阅读 / 长篇阅读一次只显示一题，选项常驻，可以上一题下一题来回改。
 * 3. 选词填空把空位做进文章里，待选词库常驻下方：先点空位、再点词。
 */
export default function TrainingDoc({ paper, section, passage, index }: Props) {
  const fontSize = usePrefs((s) => s.readingFont)
  const cloze = isCloze(passage)
  const hasZh = useMemo(() => hasTranslation(passage), [passage])

  /** 听力默认不摊开原文（听写才对，看着原文做听力等于做阅读） */
  const [showText, setShowText] = useState(section.id !== 'listening')
  const [showZh, setShowZh] = useState(false)
  const [sizePanel, setSizePanel] = useState(false)
  const [sheetWord, setSheetWord] = useState<string | null>(null)

  /** 题号 → 选项字母 */
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [submitted, setSubmitted] = useState(false)
  const [current, setCurrent] = useState(0)
  /** 选词填空：当前选中的空位 */
  const [activeBlank, setActiveBlank] = useState<number | null>(null)
  /** 选词填空：展开了解析的空位 */
  const [openBlank, setOpenBlank] = useState<number | null>(null)

  const questions = passage.questions
  const judged = questions.filter(isObjective)
  const answeredCount = questions.filter((q) => answers[q.no]).length
  const rightCount = judged.filter((q) => answers[q.no] === q.answer).length

  /** 信息匹配没有选项，用它自己的段号 A..O 当选项 */
  const matchKeys = useMemo(() => {
    const labels = passage.paras
      .map((p) => p.sents[0]?.label)
      .filter((x): x is string => Boolean(x))
    return labels.length > 0 ? labels : 'ABCDEFGHIJKLMNO'.split('')
  }, [passage])

  function pick(no: number, key: string) {
    if (submitted) return
    setAnswers((prev) => ({ ...prev, [no]: prev[no] === key ? '' : key }))
  }

  function fillBlank(bankKey: string) {
    if (submitted) return
    // 没点空位就直接点词也能用：落到第一个空着的空位上。
    // 只允许「先点空位再点词」会让词库那一排在没选中时点了没反应，像坏了
    const target = activeBlank ?? questions.find((x) => !answers[x.no])?.no
    if (target === undefined) return
    setAnswers((prev) => ({ ...prev, [target]: bankKey }))
    setActiveBlank(null)
  }

  function clearBlank(no: number) {
    if (submitted) return
    setAnswers((prev) => ({ ...prev, [no]: '' }))
  }

  /** 哪个空位用了哪个词（同一词只能用一次） */
  const usedBy = useMemo(() => {
    const map = new Map<string, number>()
    for (const [no, key] of Object.entries(answers)) if (key) map.set(key, Number(no))
    return map
  }, [answers])

  const q = questions[current]

  return (
    <div className={styles.doc} data-size={fontSize}>
      <div className={styles.toolbar}>
        <span className={styles.meta}>
          {section.label} · 第 {index + 1} 篇 · {questions.length} 题
        </span>
        <div className={styles.actions}>
          {section.id === 'listening' && (
            <button
              type="button"
              className={styles.action}
              data-on={showText}
              onClick={() => setShowText((v) => !v)}
            >
              原文
            </button>
          )}
          {hasZh && showText && (
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
            这份题库包不含听力音频。先按题目选，需要原文时点右上「原文」。
          </p>
        </div>
      )}

      {passage.brief && showText && <p className={styles.brief}>{passage.brief}</p>}

      {!showText && (
        <p className={styles.hiddenHint}>原文已隐藏 · 点右上「原文」展开（带逐句中译）</p>
      )}

      {showText && (
        <article className={styles.body}>
          {passage.paras.map((para, pi) => (
            <div key={pi} className={styles.paraWrap}>
              <p className={`${styles.para} ${styles.en}`}>
                {para.sents.map((s, si) => (
                  <span key={si} data-sentence="true">
                    {s.label && <span className={styles.paraLabel}>{s.label}</span>}
                    {splitBlanks(s.en).map((chunk, ci) =>
                      chunk.kind === 'blank' ? (
                        <Blank
                          key={`b${ci}`}
                          no={chunk.no}
                          chosen={answers[chunk.no]}
                          answer={questions.find((x) => x.no === chunk.no)?.answer}
                          submitted={submitted}
                          active={activeBlank === chunk.no}
                          onClick={() => {
                            if (submitted) return
                            if (answers[chunk.no]) clearBlank(chunk.no)
                            else setActiveBlank(chunk.no)
                          }}
                        />
                      ) : (
                        tokenize(chunk.text).map((part, j) =>
                          part.isWord ? (
                            <span key={`${ci}-${j}`} className={styles.glue}>
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
                            <span key={`${ci}-${j}`}>{part.text}</span>
                          ),
                        )
                      ),
                    )}
                    {showZh && s.zh && <span className={styles.zh}>{s.zh}</span>}{' '}
                  </span>
                ))}
              </p>
              {showZh && para.zh && <p className={styles.paraZh}>{para.zh}</p>}
            </div>
          ))}
        </article>
      )}

      {(passage.notes ?? []).map((note, i) => (
        <p key={i} className={styles.note}>
          {note}
        </p>
      ))}

      {cloze ? (
        <ClozePanel
          questions={questions}
          bank={passage.bank ?? []}
          answers={answers}
          usedBy={usedBy}
          submitted={submitted}
          activeBlank={activeBlank}
          openBlank={openBlank}
          onFill={fillBlank}
          onOpen={setOpenBlank}
        />
      ) : (
        q && (
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.panelNo}>
                第 {current + 1} / {questions.length} 题
              </span>
              <div className={styles.nav}>
                <button
                  type="button"
                  className={styles.navBtn}
                  disabled={current === 0}
                  onClick={() => setCurrent((c) => Math.max(0, c - 1))}
                >
                  上一题
                </button>
                <button
                  type="button"
                  className={styles.navBtn}
                  disabled={current >= questions.length - 1}
                  onClick={() => setCurrent((c) => Math.min(questions.length - 1, c + 1))}
                >
                  下一题
                </button>
              </div>
            </div>

            <p className={styles.stem}>
              <span className={styles.qNo}>{q.no}</span>
              {q.stem ?? '（听力题：无书面题干）'}
            </p>

            <ul className={styles.opts}>
              {(q.options && q.options.length > 0
                ? q.options
                : matchKeys.map((k) => ({ key: k, text: '' }))
              ).map((o) => {
                const chosen = answers[q.no] === o.key
                let state: string | undefined = chosen ? 'chosen' : undefined
                if (submitted) {
                  if (o.key === q.answer) state = 'right'
                  else if (chosen) state = 'wrong'
                  else state = undefined
                }
                return (
                  <li key={o.key}>
                    <button
                      type="button"
                      className={styles.opt}
                      data-state={state}
                      onClick={() => pick(q.no, o.key)}
                    >
                      <span className={styles.optKey}>{o.key}</span>
                      {o.text && <span className={styles.optText}>{o.text}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>

            {submitted && <Analysis q={q} picked={answers[q.no]} />}
          </section>
        )
      )}

      <div className={styles.submitBar}>
        {submitted ? (
          <p className={styles.score}>
            已提交 · 答对 {rightCount} / {judged.length}
            {answeredCount < questions.length ? `（${questions.length - answeredCount} 题未答）` : ''}
          </p>
        ) : (
          <>
            <p className={styles.progress}>
              已答 {answeredCount} / {questions.length} 题
            </p>
            <button type="button" className={styles.submit} onClick={() => setSubmitted(true)}>
              提交答卷
            </button>
          </>
        )}
      </div>

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

function Blank({
  no,
  chosen,
  answer,
  submitted,
  active,
  onClick,
}: {
  no: number
  chosen?: string
  answer?: string
  submitted: boolean
  active: boolean
  onClick: () => void
}) {
  const right = submitted && chosen && chosen === answer
  const wrong = submitted && chosen && chosen !== answer
  return (
    <button
      type="button"
      className={styles.blank}
      data-filled={chosen ? 'true' : 'false'}
      data-active={active ? 'true' : 'false'}
      data-right={right ? 'true' : wrong ? 'false' : undefined}
      onClick={onClick}
    >
      {chosen || no}
    </button>
  )
}

function ClozePanel({
  questions,
  bank,
  answers,
  usedBy,
  submitted,
  activeBlank,
  openBlank,
  onFill,
  onOpen,
}: {
  questions: TrainingQuestion[]
  bank: TrainingOption[]
  answers: Record<number, string>
  usedBy: Map<string, number>
  submitted: boolean
  activeBlank: number | null
  openBlank: number | null
  onFill: (key: string) => void
  onOpen: (no: number | null) => void
}) {
  const right = questions.filter((q) => answers[q.no] === q.answer).length

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelNo}>待选词库</span>
        <span className={styles.panelTip}>
          {submitted
            ? `答对 ${right} / ${questions.length}`
            : activeBlank
              ? `填第 ${activeBlank} 空`
              : '点空位或直接点词'}
        </span>
      </div>

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

      {submitted && (
        <ul className={styles.blankList}>
          {questions.map((q) => {
            const ok = answers[q.no] === q.answer
            const open = openBlank === q.no
            return (
              <li key={q.no}>
                <button type="button" className={styles.blankRow} onClick={() => onOpen(open ? null : q.no)}>
                  <span className={styles.qNo}>{q.no}</span>
                  <span data-ok={ok ? 'true' : 'false'}>
                    {answers[q.no] ? `你选 ${answers[q.no]}` : '未答'}
                    {ok ? ' ✓' : ` · 正确 ${q.answer ?? '—'}`}
                  </span>
                  <span className={styles.blankMore}>{open ? '收起' : '解析'}</span>
                </button>
                {open && <Analysis q={q} picked={answers[q.no]} compact />}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Analysis({ q, picked, compact }: { q: TrainingQuestion; picked?: string; compact?: boolean }) {
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
        {q.source ? `（${q.source}）` : ''}
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
