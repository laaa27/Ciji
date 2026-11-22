import { useMemo, useRef, useState } from 'react'

import {
  KIND_LABEL,
  LEVEL_LABEL,
  LEVELS,
  WORD_LIMITS,
  type ArticleLevel,
  type GenProgress,
  type WordKind,
} from '@/domain/article'
import { monthDay } from '@/lib/date'

import { useReturnScroll } from '../hooks/useReturnScroll'
import { useSubView } from '../hooks/useSubView'
import { useWordPicking, WORD_KINDS } from '../hooks/useWordPicking'
import styles from './GenerateArticle.module.css'
import BackButton from './BackButton'
import DateCalendar from './DateCalendar'
import CoverageReset from './gen/CoverageReset'
import GenProgressPanel from './gen/GenProgressPanel'
import WordPickList from './gen/WordPickList'

/**
 * 生成文章（二级页面）。
 *
 * 和文章库同一套形态：标题行 + 内容，从阅读页推进来、返回时退回去。
 *
 * 这一页只做界面编排：
 * - 选词状态（日期 / 类型 / 勾选 / 草稿恢复）在 `useWordPicking`
 * - 生成进度在 `GenProgressPanel`，清除已用记录在 `CoverageReset`
 * - 词表两组在 `WordPickList`
 *
 * 产品规则没变：日期只能选有记录的那一天（默认今天，以前最近 7 天混在一起会把历史词
 * 带进来）；类型多选决定默认勾选；当天已被旧文章用过的词默认不出现，开关可展开手动勾选。
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
  /** 选日期是这一页自己的二级视图：安卓返回键按栈先关它 */
  const pageRef = useRef<HTMLDivElement>(null)
  /** 进日历前排到哪儿了 —— 回来要接着看，别被弹回顶部 */
  const scroll = useReturnScroll(pageRef)
  const cal = useSubView<'calendar'>({ onEnter: scroll.onEnter, onExit: scroll.onExit })

  const [limit, setLimit] = useState(initialLimit)
  const [level, setLevel] = useState(initialLevel)

  const picking = useWordPicking({ today, limit })
  const { date, kinds, usedWords, loading, allCandidates, visible, chosen, rest } = picking

  /**
   * 快捷条：最近 7 个有记录的日子（days 已是倒序）。
   * 从日历选到更早的日期时把它补在末尾 —— 否则当前选中的那天在条上看不见，
   * 用户会以为没选上。
   */
  const strip = useMemo(() => {
    if (days.length === 0) return []
    const near = days.slice(0, 7)
    return near.includes(date) ? near : [...near, date]
  }, [days, date])

  /** 日历要按「有没有记录」决定哪格能点 */
  const daySet = useMemo(() => new Set(days), [days])

  async function handleGenerate() {
    const words = picking.pick()
    if (words.length === 0) return
    await onGenerate({ date, words, kinds, level })
  }

  // 选日期整棵子树换掉，而不是盖在上面：日历页下不该还留着词表和「已选 N」
  if (cal.view === 'calendar') {
    return (
      <div className={styles.view} ref={pageRef} data-view="true">
        <DateCalendar
          value={date}
          days={daySet}
          today={today}
          onPick={(next) => {
            picking.setDate(next)
            cal.close()
          }}
          onBack={cal.close}
        />
      </div>
    )
  }

  return (
    <div className={styles.view} ref={pageRef} data-return={cal.returning ? 'true' : 'false'}>
      <header className={styles.header}>
        <BackButton onClick={onBack} />
        <h1 className={styles.title}>生成文章</h1>
        <span className={styles.count}>已选 {chosen.length}</span>
      </header>

      <section className={styles.field}>
        {/* 标题行右侧是日历入口：只用 CSS 画一个右箭头（与历史页「统计」那颗同款） */}
        <div className={styles.fieldHead}>
          <h2 className={styles.fieldLabel}>哪一天</h2>
          {days.length > 0 && (
            <button
              type="button"
              className={styles.calOpen}
              onClick={() => cal.open('calendar')}
              aria-label="打开日历选日期"
            >
              <span className={styles.calChev} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className={styles.days}>
          {strip.map((d) => (
            <button
              key={d}
              type="button"
              className={styles.day}
              data-on={d === date}
              onClick={() => picking.setDate(d)}
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
          {WORD_KINDS.map((k) => {
            const total = allCandidates.filter((c) => c.kinds.includes(k)).length
            const unused = allCandidates.filter((c) => c.kinds.includes(k) && !c.used).length
            // 展示口径跟着开关走：打开「包含已用」→ 全量数；
            // 关着但还有词被藏起来 → 「未用/总数」，别让人以为词丢了
            const shown = picking.showUsed || total === unused ? total : `${unused}/${total}`
            return (
              <button
                key={k}
                type="button"
                className={styles.kind}
                data-on={kinds.includes(k)}
                onClick={() => picking.toggleKind(k)}
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
          <input
            type="checkbox"
            className={styles.switch}
            checked={picking.showUsed}
            onChange={picking.toggleUsed}
          />
        </label>
      )}

      {usedWords.size > 0 && (
        <CoverageReset date={date} disabled={loading} onDone={picking.reload} />
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
          尽管生成文的结构已尽量参照真题数据（篇幅、句长、文体分布），但这个功能仅适合用来巩固单词、练习长难句分析，不建议当作真题替代品使用。
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
        {picking.overLimit && (
          <p className={styles.warn}>
            选了 {chosen.length} 个，超过上限 {limit}。按「忘记 → 模糊 → 新学」的顺序取前 {limit} 个。
          </p>
        )}
        {/* 词密度是真问题：340 词塞 15 个生僻词，平均每 22 词一个，比真题密得多，容易写成硬凑 */}
        <p className={styles.hint}>
          选得越多，文章越容易为了塞词而生硬。一篇文章里 10~15 个词已经偏密了。
        </p>
      </section>

      {loading && <p className={`${styles.hint} loading-pulse`}>正在读取这天的单词…</p>}

      {!loading && visible.length === 0 && (
        <p className={styles.hint}>
          {usedWords.size > 0
            ? '这天的词都用过了。打开上面的开关，可以挑几个再写一篇。'
            : '这天没有符合条件的新学 / 模糊 / 忘记的词。换一天，或者去墨墨多背几个。'}
        </p>
      )}

      {!loading && (
        <>
          <WordPickList title="将使用" items={chosen} on={true} onToggle={picking.toggleWord} />
          <WordPickList title="不使用" items={rest} on={false} onToggle={picking.toggleWord} />
        </>
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

      {busy && <GenProgressPanel stage={stage} />}
    </div>
  )
}
