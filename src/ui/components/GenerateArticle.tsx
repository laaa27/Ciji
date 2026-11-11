import { useEffect, useMemo, useRef, useState } from 'react'

import { getCoveredWordsToday, markDayCoverageSkipped } from '@/data/article'
import { getDay } from '@/data/store'
import {
  defaultSelection,
  LEVELS,
  LEVEL_LABEL,
  trimSelection,
  wordCandidates,
  KIND_LABEL,
  WORD_LIMITS,
  type ArticleLevel,
  type GenProgress,
  type WordCandidate,
  type WordKind,
} from '@/domain/article'
import type { TodaySnapshot } from '@/domain/collect'
import { monthDay } from '@/lib/date'
import { readGenDraft, saveGenDraft } from '@/store/ui'

import styles from './GenerateArticle.module.css'

/**
 * 生成文章（二级页面）。
 *
 * 和文章库同一套形态：标题行 + 内容，从阅读页推进来、返回时退回去。
 *
 * 这一页的职责是「把要用的词确认清楚」：
 * - 日期：只能选有记录的那一天，默认今天（以前是最近 7 天混在一起，会把历史词带进来）
 * - 类型：忘记 / 模糊 / 新学，可任意组合，决定默认勾选哪些词
 * - 难度与词数上限：放在词表上方，先定参数再核对词
 * - 词表：分成「将使用」和「不使用」两组，每个词都能单独点
 * - 当天已被旧文章用过的词默认不出现，顶部开关可展开并手动勾选
 */

export type GenerateRequest = {
  date: string
  words: string[]
  kinds: WordKind[]
  level: ArticleLevel
}

type Props = {
  /** 有记录的日期，倒序 */
  days: string[]
  today: string
  initialLevel: ArticleLevel
  initialLimit: number
  busy: boolean
  /** 生成阶段，busy 时用来交代「模型现在在干嘛」 */
  stage: GenProgress | null
  error: string | null
  onBack: () => void
  onGenerate: (req: GenerateRequest) => Promise<void>
  onLevelChange: (level: ArticleLevel) => void
  onLimitChange: (limit: number) => void
}

const KINDS: WordKind[] = ['forget', 'vague', 'new']

/**
 * 三步进度：只表示"走到哪一步"，不画百分比。
 * 每一步的真实耗时随思考量波动（20~90 秒都见过），画进度条只会骗人。
 */
const STEPS: { key: 'outline' | 'draft' | 'save'; label: string }[] = [
  { key: 'outline', label: '列提纲' },
  { key: 'draft', label: '写正文' },
  { key: 'save', label: '存文章' },
]

/** 阶段 → 一句人话 */
function stageLine(stage: GenProgress | null): string {
  if (!stage) return '正在连接模型…'
  switch (stage.stage) {
    case 'outline':
      return '在读这些词，先想清楚这篇要论证什么'
    case 'draft':
      return '按提纲写正文，逐句把目标词放进论证里'
    case 'revise':
      return '上一稿没过检查（篇幅 / 缺词 / 句式），正在重写'
    case 'save':
      return '写完了，正在存进文章库'
  }
}

const KIND_COLOR: Record<WordKind, string> = {
  forget: 'var(--state-forget)',
  vague: 'var(--state-vague)',
  new: 'var(--state-new)',
}

export default function GenerateArticle({
  days,
  today,
  initialLevel,
  initialLimit,
  busy,
  stage,
  error,
  onBack,
  onGenerate,
  onLevelChange,
  onLimitChange,
}: Props) {
  // 上次的选词草稿：进程被系统回收后回来，不用重新挑一遍
  const [draft] = useState(readGenDraft)
  const restored = useRef(false)

  const [date, setDate] = useState(draft?.date ?? today)
  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null)
  const [usedWords, setUsedWords] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const [kinds, setKinds] = useState<WordKind[]>(() => {
    const saved = draft?.kinds.filter((k): k is WordKind => KINDS.includes(k as WordKind))
    return saved && saved.length > 0 ? saved : KINDS
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showUsed, setShowUsed] = useState(false)
  const [limit, setLimit] = useState(initialLimit)
  const [level, setLevel] = useState<ArticleLevel>(initialLevel)

  // 「清除当天已用记录」：两步确认 + 完成后重读数据
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearMsg, setClearMsg] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  /** 生成期间的秒表：只让用户知道"还在动"，不做预估 */
  const [waited, setWaited] = useState(0)
  useEffect(() => {
    if (!busy) {
      setWaited(0)
      return
    }
    const t0 = Date.now()
    const id = setInterval(() => setWaited(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [busy])

  const activeStep = stage?.stage === 'save' ? 2 : stage?.stage === 'outline' ? 0 : 1
  const revising = stage?.stage === 'revise'

  async function handleClearCoverage() {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setConfirmClear(false)
    try {
      const n = await markDayCoverageSkipped(date)
      setClearMsg(
        n > 0 ? `已清除 ${n} 篇文章的已用标记，单词恢复可选` : '今天还没有需要清除的记录',
      )
    } catch (e) {
      setClearMsg(e instanceof Error ? e.message : '清除失败，请重试')
    }
    setReloadTick((t) => t + 1)
  }

  // 换日期：读那天的快照 + 那天已用过的词，然后按当前类型重算默认勾选
  useEffect(() => {
    let alive = true
    setLoading(true)

    void (async () => {
      const [snap, covered] = await Promise.all([getDay(date), getCoveredWordsToday(date)])
      if (!alive) return
      setSnapshot(snap)
      setUsedWords(covered)

      const cands = wordCandidates(snap, covered)
      const fallback = new Set(defaultSelection(cands, KINDS))

      // 第一次进来且有草稿：沿用草稿的勾选（只保留这天还在候选里的词）
      if (!restored.current && draft?.selected?.length) {
        const available = new Set(cands.map((c) => c.spelling.toLowerCase()))
        const kept = new Set(draft.selected.filter((s) => available.has(s)))
        if (kept.size > 0) {
          restored.current = true
          setSelected(kept)
          setShowUsed(false)
          setLoading(false)
          return
        }
      }

      restored.current = true
      setSelected(fallback)
      setShowUsed(false)
      setLoading(false)
    })()

    return () => {
      alive = false
    }
  }, [date, draft, reloadTick])

  // 勾选/类型/日期一变就记一笔，被杀之后还能接着来
  useEffect(() => {
    if (loading) return
    saveGenDraft({ date, kinds, selected: [...selected] })
  }, [date, kinds, selected, loading])

  const allCandidates = useMemo(
    () => wordCandidates(snapshot, usedWords),
    [snapshot, usedWords],
  )

  // 类型变了：重算应该默认勾上/取消哪些（已用手动词保留）
  function toggleKind(kind: WordKind) {
    const nextKinds = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind]
    setKinds(nextKinds)

    setSelected((prev) => {
      const next = new Set(prev)
      for (const c of allCandidates) {
        const key = c.spelling.toLowerCase()
        const match = c.kinds.includes(kind)
        if (!match || c.used) continue
        if (nextKinds.includes(kind)) {
          // 刚勾上这个类型 → 补进选择
          next.add(key)
        } else if (!c.kinds.some((k) => nextKinds.includes(k))) {
          // 刚取消 → 只撤掉「不落在任何剩余类型里」的词。
          // 多重归属的词（比如既是忘记又是新学）只要还有别的类型勾着就保留——
          // 否则「只看忘记」会把既是忘记又是新学的词全删光，明明 22 个忘记词只剩 1 个
          next.delete(key)
        }
      }
      return next
    })
  }

  function toggleWord(c: WordCandidate) {
    const key = c.spelling.toLowerCase()
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleUsed() {
    const next = !showUsed
    setShowUsed(next)

    // 收起「已用」时，把它们从选择里摘掉，避免出现「看不见却被用上」
    if (!next) {
      setSelected((prev) => {
        const copy = new Set(prev)
        for (const c of allCandidates) {
          if (c.used) copy.delete(c.spelling.toLowerCase())
        }
        return copy
      })
    }
  }

  const visible = showUsed ? allCandidates : allCandidates.filter((c) => !c.used)
  const chosen = visible.filter((c) => selected.has(c.spelling.toLowerCase()))
  const rest = visible.filter((c) => !selected.has(c.spelling.toLowerCase()))
  const overLimit = chosen.length > limit

  async function handleGenerate() {
    const words = trimSelection(allCandidates, selected, limit)
    if (words.length === 0) return
    await onGenerate({ date, words, kinds, level })
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={onBack}>
          <span aria-hidden="true">‹</span> 返回
        </button>
        <h1 className={styles.title}>生成文章</h1>
        <span className={styles.count}>已选 {chosen.length}</span>
      </header>

      <section className={styles.field}>
        <h2 className={styles.fieldLabel}>哪一天</h2>
        <div className={styles.days}>
          {days.map((d) => (
            <button
              key={d}
              type="button"
              className={styles.day}
              data-on={d === date}
              onClick={() => setDate(d)}
            >
              {d === today ? '今天' : monthDay(d)}
            </button>
          ))}
          {days.length === 0 && <p className={styles.hint}>还没有学习记录</p>}
        </div>
      </section>

      <section className={styles.field}>
        <h2 className={styles.fieldLabel}>词的类型</h2>
        <div className={styles.kinds}>
          {KINDS.map((k) => {
            const total = allCandidates.filter((c) => c.kinds.includes(k)).length
            const unused = allCandidates.filter((c) => c.kinds.includes(k) && !c.used).length
            // 展示口径跟着开关走：打开「包含已用」→ 全量数；
            // 关着但还有词被藏起来 → 「未用/总数」，别让人以为词丢了
            const shown = showUsed || total === unused ? total : `${unused}/${total}`
            return (
              <button
                key={k}
                type="button"
                className={styles.kind}
                data-on={kinds.includes(k)}
                onClick={() => toggleKind(k)}
              >
                <span className={styles.tick} aria-hidden="true" />
                {KIND_LABEL[k]}
                <span className={styles.kindCount}>{shown}</span>
              </button>
            )
          })}
        </div>
        <p className={styles.hint}>
          勾选决定默认用哪些词，下面还可以逐词调整。斜杠后是含已用词的总数；已用过的默认不出现，打开下面的开关再练。
        </p>
      </section>

      {usedWords.size > 0 && (
        <label className={styles.switchRow}>
          <span className={styles.switchText}>
            包含这天已经用过的词
            <em>共 {usedWords.size} 个，打开后可以手动勾选，再练一次</em>
          </span>
          <input type="checkbox" className={styles.switch} checked={showUsed} onChange={toggleUsed} />
        </label>
      )}

      {usedWords.size > 0 && (
        <div className={styles.clearRow}>
          <button
            type="button"
            className={confirmClear ? styles.clearBtn : styles.clearBtnGhost}
            onClick={() => void handleClearCoverage()}
            disabled={loading}
          >
            {confirmClear
              ? '确认清除？（单词会恢复默认可选）'
              : '清除今天已生成文章的记录'}
          </button>
          {clearMsg && <p className={styles.hint}>{clearMsg}</p>}
        </div>
      )}

      <section className={styles.field}>
        <h2 className={styles.fieldLabel}>难度</h2>
        <div className={styles.segments}>
          {LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              className={styles.segment}
              data-on={level === l}
              onClick={() => {
                setLevel(l)
                onLevelChange(l)
              }}
            >
              {LEVEL_LABEL[l]}
            </button>
          ))}
        </div>
        {/* 说明写在难度下面而不是弹窗里：调难度的人一定会看到 */}
        <p className={styles.hint}>
          生成文的结构已尽量参照真题数据（篇幅、句长、文体分布），但这个功能适合用来
          <strong> 巩固单词、练长难句 </strong>
          ，不要当作模考卷或真题替代品使用。
        </p>
      </section>

      <section className={styles.field}>
        <h2 className={styles.fieldLabel}>词数上限</h2>
        <div className={styles.segments}>
          {WORD_LIMITS.map((n) => (
            <button
              key={n}
              type="button"
              className={styles.segment}
              data-on={limit === n}
              onClick={() => {
                setLimit(n)
                onLimitChange(n)
              }}
            >
              {n}
            </button>
          ))}
        </div>
        {overLimit && (
          <p className={styles.warn}>
            选了 {chosen.length} 个，超过上限 {limit}。按「忘记 → 模糊 → 新学」的顺序取前 {limit} 个。
          </p>
        )}
      </section>

      {loading && <p className={`${styles.hint} loading-pulse`}>正在读取这天的单词…</p>}

      {!loading && visible.length === 0 && (
        <p className={styles.hint}>
          {usedWords.size > 0
            ? '这天的词都用过了。打开上面的开关，可以挑几个再写一篇。'
            : '这天没有符合条件的新学 / 模糊 / 忘记的词。换一天，或者去墨墨多背几个。'}
        </p>
      )}

      {!loading && chosen.length > 0 && (
        <section className={styles.group}>
          <h2 className={styles.groupHead}>
            将使用 <span className={styles.groupCount}>{chosen.length}</span>
          </h2>
          <ul>
            {chosen.map((c) => (
              <li key={c.spelling}>
                <button type="button" className={styles.word} data-on="true" onClick={() => toggleWord(c)}>
                  <span className={styles.marks}>
                    {c.kinds.map((k) => (
                      <span key={k} className={styles.mark} style={{ background: KIND_COLOR[k] }} />
                    ))}
                  </span>
                  <span className={styles.spelling}>{c.spelling}</span>
                  {c.used && <span className={styles.used}>已用</span>}
                  <span className={styles.kindsText}>
                    {c.kinds.map((k) => KIND_LABEL[k]).join(' / ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!loading && rest.length > 0 && (
        <section className={styles.group}>
          <h2 className={styles.groupHead}>
            不使用 <span className={styles.groupCount}>{rest.length}</span>
          </h2>
          <ul>
            {rest.map((c) => (
              <li key={c.spelling}>
                <button type="button" className={styles.word} data-on="false" onClick={() => toggleWord(c)}>
                  <span className={styles.marks}>
                    {c.kinds.map((k) => (
                      <span key={k} className={styles.mark} style={{ background: KIND_COLOR[k] }} />
                    ))}
                  </span>
                  <span className={styles.spelling}>{c.spelling}</span>
                  {c.used && <span className={styles.used}>已用</span>}
                  <span className={styles.kindsText}>
                    {c.kinds.map((k) => KIND_LABEL[k]).join(' / ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className={styles.error}>{error}</p>}

      <button
        type="button"
        className={styles.primary}
        onClick={() => void handleGenerate()}
        disabled={busy || chosen.length === 0 || loading}
      >
        {busy ? '生成中…' : `用 ${Math.min(chosen.length, limit)} 个词生成`}
      </button>

      {busy && (
        <div className={styles.progress} role="status" aria-live="polite">
          <div className={styles.steps}>
            {STEPS.map((s, i) => (
              <span
                key={s.key}
                className={styles.step}
                data-on={i === activeStep}
                data-done={i < activeStep}
              >
                <span className={styles.dot} aria-hidden="true" />
                {revising && i === 1 ? '重写正文' : s.label}
              </span>
            ))}
          </div>
          <p className={styles.progressLine}>
            {stageLine(stage)}
            <span className={styles.waited}> · 已等 {waited} 秒</span>
          </p>
        </div>
      )}
    </div>
  )
}
