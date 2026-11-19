import { useEffect, useMemo, useRef, useState } from 'react'

import {
  hasTranslation,
  isCloze,
  isObjective,
  type TrainingPaper,
  type TrainingPassage,
  type TrainingSection,
} from '@/domain/training'
import { fmtDuration } from '@/lib/date'
import { usePrefs, type FontSize } from '@/store/prefs'

import { ChoiceBar } from './ChoiceBar'
import { ClozeBar, ClozeResult } from './ClozeBar'
import { OrderingBar } from './OrderingBar'
import { TrainingReader } from './TrainingReader'
import ThemeToggle from './ThemeToggle'
import WordSheet from './WordSheet'
import { useStopwatch } from '../hooks/useStopwatch'
import { useWordSelection } from '../hooks/useWordSelection'
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

/**
 * 做题界面。
 *
 * 四条规则，都跟阅读页不同：
 * 1. 选项条跟词卡一样浮在底栏上方 —— 滑到文章任何位置都能答题，不用来回滚。
 * 2. 答完不判对错，点「提交答卷」才出答案与解析。当场判分等于边做边看答案。
 * 3. 阅读 / 新题型一次一题，可上一题下一题；新题型共享选项池互斥——选项被占用时
 *    置灰可点，点了即抢占（原题自动清空）。排序题例外：链图一次全览，无逐题切换。
 * 4. 选词填空把空位做进文章里，待选词库常驻下方。
 *
 * 正文渲染在 TrainingReader，选择题答题条在 ChoiceBar，选词填空条与逐空结果在 ClozeBar，
 * 解析在 Analysis —— 本文件只管做题状态（答案 / 提交 / 翻题）与工具栏。
 */
export default function TrainingDoc({ paper, section, passage, ordinal, onScore }: Props) {
  const fontSize = usePrefs((s) => s.readingFont)
  const cloze = isCloze(passage)
  const hasZh = useMemo(() => hasTranslation(passage), [passage])
  /**
   * 翻译题（考研 Part C）：没有可选项、没有对错，所以既没有答题条，也没有「提交」。
   * 只有原文、题目要求和译文对照 —— 把整屏留给文章。
   */
  const isTranslation = section.id === 'translation'
  /** 新题型变体：仅 matching 节有；阅读理解（reading1/2）不设 kind，选项可随意重复选择 */
  const isMatchingSection = section.id === 'matching'
  const kind = isMatchingSection ? (passage.kind ?? 'matching') : undefined
  const ordering = kind === 'ordering' && Boolean(passage.chain?.length)
  /** 共享选项池互斥（抢占换选）：只作用于新题型；判断题 T/F 每题独立，不抢占 */
  const sharedPool = isMatchingSection && kind !== 'tf'

  const [showZh, setShowZh] = useState(false)
  const [sizePanel, setSizePanel] = useState(false)
  /** 点词查词 + 短语匹配 + 返回键关弹层：与阅读页同一套（见 hook 注释） */
  const sel = useWordSelection()
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
  /** 排序题：展开了解析的槽位 */
  const [openOrder, setOpenOrder] = useState<number | null>(null)
  /** 选项条收起：想把整屏留给文章时用 */
  const [barCollapsed, setBarCollapsed] = useState(false)

  const questions = passage.questions
  const judged = questions.filter(isObjective)
  const answeredCount = questions.filter((q) => answers[q.no]).length
  const rightCount = judged.filter((q) => answers[q.no] === q.answer).length

  /** 本次做题用时：进入即计时，提交后停表；开着词卡查词也算在做题里 */
  const elapsed = useStopwatch(!submitted)

  /**
   * 翻译题没有提交键，那「做完了」这件事只能靠离开这一节来判定。
   * 卸载时记一条「已读」成绩（total=0），列表页据此显示上次做的日期与用时。
   * onScore 是父组件的内联函数，每次渲染都换身份 —— 存进 ref，否则只要父组件重渲染
   * 就触发一次 cleanup，会把假成绩提前写下去。
   */
  const elapsedRef = useRef(elapsed)
  elapsedRef.current = elapsed
  const scoreRef = useRef(onScore)
  scoreRef.current = onScore
  const scored = useRef(false)
  useEffect(() => {
    if (!isTranslation) return
    return () => {
      if (scored.current) return
      scored.current = true
      scoreRef.current({
        passageId: passage.id,
        right: 0,
        total: 0,
        at: new Date().toISOString(),
        secs: elapsedRef.current,
      })
    }
  }, [isTranslation, passage.id])

  /** 共享选项池：新题型各题的选项相同（A–G），任取一题的即可 */
  const pool = useMemo(
    () => questions.find((q) => q.options?.length)?.options ?? [],
    [questions],
  )
  /** 原文空位回填的内容：小标题回填标题文本，其余回填大写字母 */
  const blankDisplay = (no: number): string | undefined => {
    const key = answers[no]
    if (!key) return undefined
    if (kind === 'headings') return pool.find((o) => o.key === key)?.text ?? key
    return key
  }

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
    setAnswers((prev) => {
      const next = { ...prev }
      if (next[no] === key) {
        // 再点一次同一选项：清空本题
        next[no] = ''
        return next
      }
      // 抢占换选：该选项被别的题占用时，那题自动清空回未答。
      // 只在共享选项池（新题型）里生效；阅读理解各题独立，同一选项可重复选
      if (sharedPool) {
        for (const [otherNo, otherKey] of Object.entries(prev)) {
          if (otherKey === key) next[Number(otherNo)] = ''
        }
      }
      next[no] = key
      return next
    })
    setActiveBlank(null)
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
      data-qbar={isTranslation ? undefined : barCollapsed ? 'mini' : 'open'}
    >
      <div className={styles.toolbar}>
        <span className={styles.meta}>
          {section.label}
          {ordinal > 0 ? ` · 第 ${ordinal} 篇` : ''} ·{' '}
          {isTranslation
            ? questions.length > 1
              ? `${questions.length} 句`
              : '整段'
            : `${questions.length} 题`}
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
          {/* 白天 / 深夜：贴着计时器右边，与阅读页、设置页同源 */}
          <ThemeToggle />
          {hasZh && (
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

      {passage.brief && <p className={styles.brief}>{passage.brief}</p>}

      <TrainingReader
        passage={passage}
        questions={questions}
        showZh={showZh}
        answers={answers}
        submitted={submitted}
        activeBlank={activeBlank}
        markSet={markSet}
        wordOf={wordOf}
        blankDisplay={blankDisplay}
        blankIsHeading={kind === 'headings'}
        onBlank={(no) => {
          if (submitted) return
          if (cloze) {
            // 完形：已填点开即清空
            if (answers[no]) clearBlank(no)
            else setActiveBlank(no)
            return
          }
          // 新题型：空位点开即换选——切到对应题并弹出候选条
          const idx = questions.findIndex((q) => q.no === no)
          if (idx >= 0) setCurrent(idx)
          setActiveBlank(no)
        }}
        onWordTap={(key, parts, j) => {
          setMarkKey(key)
          sel.open(parts, j)
        }}
      />

      {ordering && passage.chain && (
        <OrderingBar
          chain={passage.chain}
          pool={matchKeys}
          answers={answers}
          submitted={submitted}
          questions={questions}
          activeSlot={activeBlank}
          onSlot={(no) => setActiveBlank(no)}
          onPick={pick}
          onSubmit={submit}
          answeredCount={answeredCount}
          total={questions.length}
          rightCount={rightCount}
          judgedCount={judged.length}
          openResult={openOrder}
          onOpenResult={setOpenOrder}
          collapsed={barCollapsed}
          onToggle={() => setBarCollapsed((v) => !v)}
        />
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

      {cloze && !isTranslation && (
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

      {/* 翻译题不要答题条：没有选项、没有对错，弹一条空壳只会挡住文章 */}
      {!cloze && !ordering && !isTranslation && q && (
        <ChoiceBar
          q={q}
          current={current}
          total={questions.length}
          answers={answers}
          submitted={submitted}
          exclusive={exclusive}
          kind={kind}
          sharedPool={sharedPool}
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

      {sel.word && (
        <WordSheet
          word={sel.word}
          phrase={sel.phrase}
          marked={markSet.has(markKey)}
          onHighlight={() => toggleMark(markKey)}
          onClose={sel.close}
          onPick={sel.pick}
        />
      )}
    </div>
  )
}
