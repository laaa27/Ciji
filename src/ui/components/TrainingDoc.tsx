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
import { fmtDuration } from '@/lib/date'
import { usePrefs, type FontSize } from '@/store/prefs'

import WordSheet from './WordSheet'
import { useStopwatch } from '../hooks/useStopwatch'
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
  /** 第几篇（阅读按题型族连续编号，见 TrainingPage 的 ordinals）；0 表示单篇题型，不标 */
  ordinal: number
  /** 提交后把本场成绩交给列表页（落盘 + 列表显示都在那边） */
  onScore: (s: { passageId: string; right: number; total: number; at: string; secs: number }) => void
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
 * 四条规则，都跟阅读页不同：
 * 1. 选项条跟词卡一样浮在底栏上方 —— 滑到文章任何位置都能答题，不用来回滚。
 * 2. 答完不判对错，点「提交答卷」才出答案与解析。当场判分等于边做边看答案。
 * 3. 阅读 / 长篇阅读一次一题，可上一题下一题；长篇阅读的段号是排他的，用过就不能再用。
 * 4. 选词填空把空位做进文章里，待选词库常驻下方。
 */
export default function TrainingDoc({ paper, section, passage, ordinal, onScore }: Props) {
  const fontSize = usePrefs((s) => s.readingFont)
  const cloze = isCloze(passage)
  const hasZh = useMemo(() => hasTranslation(passage), [passage])

  /** 听力默认不摊开原文（听着原文做听力等于做阅读） */
  const [showText, setShowText] = useState(section.id !== 'listening')
  const [showZh, setShowZh] = useState(false)
  const [sizePanel, setSizePanel] = useState(false)
  const [sheetWord, setSheetWord] = useState<string | null>(null)
  /**
   * 手动高亮：键是「段-句-片段-词序号」而不是词文本 —— 标记绑定位置，
   * 同一个词在别处的出现不跟着亮。换篇目时组件会重挂载，自然清空。
   */
  const [marks, setMarks] = useState<string[]>([])
  /** 当前词卡绑定的实例键：在词卡里点变形换词后，高亮仍落在最初点中的位置 */
  const [markKey, setMarkKey] = useState('')
  const markSet = useMemo(() => new Set(marks), [marks])
  const toggleMark = (key: string) =>
    setMarks((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]))

  /** 题号 → 选项字母 */
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [submitted, setSubmitted] = useState(false)
  const [current, setCurrent] = useState(0)
  /** 选词填空：当前选中的空位 */
  const [activeBlank, setActiveBlank] = useState<number | null>(null)
  /** 选词填空：展开了解析的空位 */
  const [openBlank, setOpenBlank] = useState<number | null>(null)
  /** 选项条收起：想把整屏留给文章时用 */
  const [barCollapsed, setBarCollapsed] = useState(false)

  const questions = passage.questions
  const judged = questions.filter(isObjective)
  const answeredCount = questions.filter((q) => answers[q.no]).length
  const rightCount = judged.filter((q) => answers[q.no] === q.answer).length

  /** 本次做题用时：进入即计时，提交后停表；开着词卡查词也算在做题里 */
  const elapsed = useStopwatch(!submitted)

  /**
   * 信息匹配没有选项，用它自己的段号 A..O 当选项。
   * 这类题的段号是排他的：一段只能被一句选一次，所以整个题型共享一个已用集合。
   */
  const matchKeys = useMemo(() => {
    const labels = passage.paras.map((p) => p.sents[0]?.label).filter((x): x is string => Boolean(x))
    return labels.length > 0 ? labels : 'ABCDEFGHIJKLMNOP'.split('')
  }, [passage])
  const exclusive = !questions.some((q) => (q.options ?? []).length > 0)

  const usedLetters = useMemo(() => {
    const map = new Map<string, number>()
    for (const [no, key] of Object.entries(answers)) if (key) map.set(key, Number(no))
    return map
  }, [answers])

  function pick(no: number, key: string) {
    if (submitted) return
    setAnswers((prev) => ({ ...prev, [no]: prev[no] === key ? '' : key }))
  }

  function fillBlank(bankKey: string) {
    if (submitted) return
    // 没点空位就直接点词也能用：落到第一个空着的空位上。
    // 只允许「先点空位再点词」会让词库那一排在未选中时点了没反应，像坏了
    const target = activeBlank ?? questions.find((x) => !answers[x.no])?.no
    if (target === undefined) return
    setAnswers((prev) => ({ ...prev, [target]: bankKey }))
    setActiveBlank(null)
  }

  function clearBlank(no: number) {
    if (submitted) return
    setAnswers((prev) => ({ ...prev, [no]: '' }))
  }

  const q = questions[current]
  const bank = passage.bank ?? []

  function submit() {
    const at = new Date().toISOString()
    setSubmitted(true)
    // 成绩交回列表页：落盘（data/training 的 saveScore）与显示都在那边
    onScore({ passageId: passage.id, right: rightCount, total: judged.length, at, secs: elapsed })
  }
  /** 选词填空：字母 → 单词。卷面上显示词，不显示字母 */
  const wordOf = (key?: string) => (key ? bank.find((b) => b.key === key)?.text : undefined)

  return (
    <div
      className={styles.doc}
      data-size={fontSize}
      data-qbar={barCollapsed ? 'mini' : 'open'}
    >
      <div className={styles.toolbar}>
        <span className={styles.meta}>
          {section.label}
          {ordinal > 0 ? ` · 第 ${ordinal} 篇` : ''} · {questions.length} 题
        </span>
        <div className={styles.actions}>
          {/* 用时：不走按钮逻辑，始终显示；计计时中用主色提示「在计」 */}
          <span
            className={styles.action}
            data-timer="true"
            data-on={!submitted}
            aria-label="本次做题用时"
          >
            {fmtDuration(elapsed)}
          </span>
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
                          word={wordOf(answers[chunk.no])}
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
                                data-mark={
                                  markSet.has(`${pi}-${si}-${ci}-${j}`) ? 'true' : undefined
                                }
                                onClick={() => {
                                  setMarkKey(`${pi}-${si}-${ci}-${j}`)
                                  setSheetWord(part.text)
                                }}
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

      {cloze && submitted && (
        <ClozeResult
          questions={questions}
          bank={bank}
          answers={answers}
          openBlank={openBlank}
          onOpen={setOpenBlank}
        />
      )}

      <p className={styles.foot}>题源：{paper.label}</p>

      {cloze && (
        <ClozeBar
          bank={bank}
          usedBy={usedLetters}
          submitted={submitted}
          answered={answeredCount}
          total={questions.length}
          right={rightCount}
          collapsed={barCollapsed}
          onToggle={() => setBarCollapsed((v) => !v)}
          onFill={fillBlank}
          onSubmit={submit}
        />
      )}

      {!cloze && q && (
        <QuestionBar
          q={q}
          current={current}
          total={questions.length}
          answers={answers}
          submitted={submitted}
          exclusive={exclusive}
          matchKeys={matchKeys}
          usedLetters={usedLetters}
          rightCount={rightCount}
          judgedCount={judged.length}
          answeredCount={answeredCount}
          collapsed={barCollapsed}
          onToggle={() => setBarCollapsed((v) => !v)}
          onPick={pick}
          onPrev={() => setCurrent((c) => Math.max(0, c - 1))}
          onNext={() => setCurrent((c) => Math.min(questions.length - 1, c + 1))}
          onSubmit={submit}
        />
      )}

      {sheetWord && (
        <WordSheet
          word={sheetWord}
          marked={markSet.has(markKey)}
          onHighlight={() => toggleMark(markKey)}
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
  word,
  answer,
  submitted,
  active,
  onClick,
}: {
  no: number
  chosen?: string
  /** 已选词的原文 —— 卷面上一段话中间写个字母很别扭，写词才读得下去 */
  word?: string
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
      {word || no}
    </button>
  )
}

/** 浮在底栏上方的答题条：与词卡同一个位置关系，滑到文章任何位置都在 */
function QuestionBar({
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
}: {
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
}) {
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
        <div className={styles.qbarNav}>
          <button
            type="button"
            className={styles.navArrow}
            disabled={current === 0}
            onClick={onPrev}
            aria-label="上一题"
          >
            ‹
          </button>
          <button
            type="button"
            className={styles.navArrow}
            disabled={current >= total - 1}
            onClick={onNext}
            aria-label="下一题"
          >
            ›
          </button>
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

      {!collapsed && (
        <div key={q.no} className={`${styles.qbarBody} ${styles.qSwitch}`}>
          <p className={styles.stem}>
            <span className={styles.qNo}>{q.no}</span>
            {q.stem ?? '（听力题：无书面题干）'}
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
      )}
    </div>
  )
}

/** 选词填空的浮动词库：与选项条同一副壳子，滑到文章任何位置都能点词 */
function ClozeBar({
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
}: {
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
}) {
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

      {!collapsed && (
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
      )}
    </div>
  )
}

/** 提交后逐空的结果：你的答案、正确答案、可展开的解析 */
function ClozeResult({
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
