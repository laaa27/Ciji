import { useEffect, useMemo, useRef, useState } from 'react'

import {
  loadTrainingIndex,
  loadTrainingPaper,
  readScore,
  saveScore,
  scoreKey,
  sweepLegacyScores,
  type TrainScore,
} from '@/data/training'
import { fmtDuration } from '@/lib/date'
import {
  LEVELS,
  type TrainingIndexItem,
  type TrainingLevel,
  type TrainingPaper,
} from '@/domain/training'

import { findScrollParent, useScrollStuck } from '../hooks/useScrollStuck'
import { useSubView } from '../hooks/useSubView'
import { useToast } from '@/store/toast'
import BackButton from '../components/BackButton'
import EmptyState from '../components/EmptyState'
import TrainingDoc from '../components/TrainingDoc'
import styles from './TrainingPage.module.css'

/**
 * 做题中的防误退窗口：第一次返回只提示，窗口内按第二次才真正退出。
 * 与 App 级「再按一次回到桌面」同一档时长。
 */
const DOC_EXIT_CONFIRM_MS = 2200

/**
 * 训练页：档位 → 套卷 → 篇目 → 做题。
 *
 * 数据是打进包里的静态 JSON（`public/training/`），由 scripts/import-training.py 生成。
 * 这一页只负责挑卷与切层，做题界面在 `components/TrainingDoc.tsx`。
 *
 * 两层二级视图（套卷详情 / 做题）各用一个 useSubView：返回动画与安卓返回键
 * 都由 hook 接管，后进先出正好是「先退做题、再退套卷」。
 */
/** 题型行右侧的成绩：没交过就不显示，交过才占位 */
function PassageScore({ score }: { score?: TrainScore }) {
  if (!score) return null
  // 翻译题没有对错，记的是「上次读的时间 + 用时」（total=0）。别显示成「0/0」
  const read = score.total === 0
  const rate = score.total > 0 ? Math.round((100 * score.right) / score.total) : 0
  return (
    <span className={styles.rowScore}>
      <span className={styles.rowRate}>
        {read ? (
          '已读'
        ) : (
          <>
            正确率 {rate}%
            <em>
              {score.right}/{score.total}
            </em>
          </>
        )}
      </span>
      <span className={styles.rowTime}>
        {score.secs !== undefined ? `用时 ${fmtDuration(score.secs)} · ` : ''}
        {clockLabel(score.at)}
      </span>
    </span>
  )
}

/**
 * ISO → 11月15日 21:07。
 *
 * 日期一律带上：做到一半隔天再进来，只有「21:07」会让人以为是今天做的。
 * 跨年了才补年份。
 */
function clockLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return `${sameYear ? md : `${d.getFullYear()}年${md}`} ${hh}:${mm}`
}

export default function TrainingPage() {
  const [level, setLevel] = useState<TrainingLevel>('cet4')
  const [index, setIndex] = useState<TrainingIndexItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [paper, setPaper] = useState<TrainingPaper | null>(null)
  /**
   * 各篇的最近一次成绩（列表右侧显示）。
   * 落盘在 data/training（提交瞬间同步写 localStorage，重启后还在）；
   * 这份 state 是展示用的缓存，进一套卷时把磁盘上的历史成绩铺进来。
   */
  const [scores, setScores] = useState<Record<string, TrainScore>>({})
  const [paperError, setPaperError] = useState<string | null>(null)

  const pageRef = useRef<HTMLDivElement>(null)
  /** 档位选择器吸顶：一百多套平铺下来，滚到深处还得能换档 */
  const levelRef = useRef<HTMLDivElement>(null)
  const levelStuck = useScrollStuck(levelRef)
  /** 进下一层之前列表停在哪 */
  const rootScroll = useRef(0)
  const paperScroll = useRef(0)

  const lastDocBackRef = useRef(0)

  /** 系统返回键与左上角箭头共用的确认：第一次提示，窗口内第二次放行 */
  function docBackConfirm(): boolean {
    const now = Date.now()
    if (now - lastDocBackRef.current < DOC_EXIT_CONFIRM_MS) {
      lastDocBackRef.current = 0
      return true
    }
    lastDocBackRef.current = now
    useToast.getState().show('再按一次退出做题')
    return false
  }

  const paperNav = useSubView<string>({
    onEnter: () => {
      const s = scroller()
      if (s) rootScroll.current = s.scrollTop
    },
    onExit: () => restore(rootScroll),
  })
  /**
   * 做题是可能丢进度的一层（答题记录不落盘，见训练进度持久化的历史），
   * 所以退它要两次确认；滚动记忆走 onEnter/onExit，让系统返回键
   * 与箭头按钮行为完全一致（以前返回键路径是不恢复滚动的）。
   */
  const docNav = useSubView<string>({
    onEnter: () => {
      const s = scroller()
      if (s) paperScroll.current = s.scrollTop
    },
    onExit: () => restore(paperScroll),
    shouldClose: docBackConfirm,
  })

  useEffect(() => {
    let alive = true
    // 0.24.13 及以前的成绩键裸用篇目 id，跨卷串号，全是脏数据——进页先清
    sweepLegacyScores()
    void loadTrainingIndex()
      .then((list) => {
        if (!alive) return
        setIndex(list)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : '题库读取失败')
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  /** 切层时滚到顶；返回时用 rAF 等 DOM 换完再恢复 */
  function scroller(): HTMLElement | null {
    return findScrollParent(pageRef.current)
  }

  function toTop() {
    const s = scroller()
    if (s) s.scrollTop = 0
  }

  function restore(pos: { current: number }) {
    const s = scroller()
    if (!s || pos.current <= 0) return
    requestAnimationFrame(() => {
      s.scrollTop = pos.current
    })
  }

  function openPaper(key: string) {
    setPaper(null)
    setPaperError(null)
    paperNav.open(key)
    toTop()
    void loadTrainingPaper(key)
      .then((p) => {
        // 这套卷的历史成绩铺进来（上次会话提交过的那些；键带套卷 key，见 scoreKey）
        const cached: Record<string, TrainScore> = {}
        for (const sec of p.sections) {
          for (const pg of sec.passages) {
            const s = readScore(p.key, pg.id)
            if (s) cached[scoreKey(p.key, pg.id)] = s
          }
        }
        if (Object.keys(cached).length > 0) {
          setScores((prev) => ({ ...cached, ...prev }))
        }
        setPaper(p)
      })
      .catch((e: unknown) => setPaperError(e instanceof Error ? e.message : '套卷读取失败'))
  }

  function closePaper() {
    paperNav.close()
  }

  function openDoc(passageId: string) {
    docNav.open(passageId)
    toTop()
  }

  /** 左上角箭头：与系统返回键走同一道确认 */
  function docBack() {
    if (!docBackConfirm()) return
    docNav.close()
  }

  const list = index.filter((p) => p.level === level)

  /**
   * 篇目序号。
   *
   * 四六级的「阅读理解」在卷面上是 Section C 的 Passage One / Passage Two，
   * 题库却拆成 reading1 / reading2 两个题型、各一篇 —— 列表里就成了两行都叫
   * 「阅读理解 · 5 题」，看不出谁是谁。所以阅读按「题型族」连续编号，
   * 四六级得到 1、2，考研的 reading1 自带四篇则得到 1~4。
   */
  const ordinals = useMemo(() => {
    const map = new Map<string, number>()
    let reading = 0
    for (const sec of paper?.sections ?? []) {
      const isReading = sec.id === 'reading1' || sec.id === 'reading2'
      sec.passages.forEach((p, i) => {
        if (isReading) {
          reading += 1
          map.set(p.id, reading)
        } else {
          map.set(p.id, i + 1)
        }
      })
    }
    return map
  }, [paper])

  /**
   * 阅读题型的篇目总数（四六级 2 篇、考研 4 篇）。
   * 只有一篇的题型（完形 / 长篇阅读）不标「第 1 篇」—— 那是噪音。
   */
  const readingCount = useMemo(
    () =>
      (paper?.sections ?? [])
        .filter((s) => s.id === 'reading1' || s.id === 'reading2')
        .reduce((n, s) => n + s.passages.length, 0),
    [paper],
  )

  /**
   * 按年份分组：一百多套平铺下来，光靠「2026 年 6 月 · 第 3 套」这行字分不清年与年
   * 的界线。分组之后每一年的第一行就是分界，眼睛有落点。
   */
  const byYear = new Map<number, TrainingIndexItem[]>()
  for (const p of list) {
    const arr = byYear.get(p.year)
    if (arr) arr.push(p)
    else byYear.set(p.year, [p])
  }
  const years = [...byYear.keys()].sort((a, b) => b - a)

  // ---- 做题 ----
  if (docNav.view && paper) {
    const section = paper.sections.find((s) => s.passages.some((p) => p.id === docNav.view))
    const pi = section ? section.passages.findIndex((p) => p.id === docNav.view) : -1
    if (section && pi >= 0) {
      return (
        <div key={`doc-${docNav.view}`} className={styles.page} data-view="doc" ref={pageRef}>
          <header className={styles.subHead}>
            <BackButton onClick={docBack} />
            <h1 className={styles.subTitle}>{section.label}</h1>
          </header>
          <TrainingDoc
            paper={paper}
            section={section}
            passage={section.passages[pi]}
            ordinal={
              section.id === 'reading1' || section.id === 'reading2'
                ? (ordinals.get(section.passages[pi].id) ?? pi + 1)
                : section.passages.length > 1
                  ? pi + 1
                  : 0
            }
            onScore={(sc) => {
              const score: TrainScore = {
                right: sc.right,
                total: sc.total,
                at: sc.at,
                secs: sc.secs,
              }
              saveScore(paper.key, sc.passageId, score)
              setScores((prev) => ({ ...prev, [scoreKey(paper.key, sc.passageId)]: score }))
            }}
          />
        </div>
      )
    }
  }

  // ---- 套卷详情 ----
  if (paperNav.view) {
    const paperKey = paperNav.view
    return (
      <div key={`paper-${paperNav.view}`} className={styles.page} data-view="paper" ref={pageRef}>
        <header className={styles.subHead}>
          <BackButton onClick={closePaper} />
          <h1 className={styles.subTitle}>{paper?.label ?? '套卷'}</h1>
        </header>

        {paperError && <p className={styles.hint}>{paperError}</p>}
        {!paper && !paperError && <p className={`${styles.hint} loading-pulse`}>读取中…</p>}

        {paper && (
          <ul className={styles.sections}>
            {paper.sections.map((sec) =>
              sec.passages.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={styles.passageRow}
                    onClick={() => openDoc(p.id)}
                  >
                    <span className={styles.passageText}>
                      <span className={styles.passageName}>
                        {sec.label}
                        {sec.id === 'reading1' || sec.id === 'reading2'
                          ? readingCount > 1
                            ? ` · 第 ${ordinals.get(p.id)} 篇`
                            : ''
                          : sec.passages.length > 1
                            ? ` · 第 ${ordinals.get(p.id)} 篇`
                            : ''}
                      </span>
                      <span className={styles.passageMeta}>
                        {/* 翻译数的是「句」：英语一 5 个划线句，英语二整段一篇 */}
                        {sec.id === 'translation'
                          ? p.questions.length > 1
                            ? `${p.questions.length} 句`
                            : '整段'
                          : `${p.questions.length} 题`}
                      </span>
                    </span>
                    <PassageScore score={scores[scoreKey(paperKey, p.id)]} />
                    <span className={styles.chevron} aria-hidden="true" />
                  </button>
                </li>
              )),
            )}
          </ul>
        )}
      </div>
    )
  }

  // ---- 套卷列表 ----
  return (
    <div className={styles.page} data-return={paperNav.returning ? 'true' : 'false'} ref={pageRef}>
      <header className={styles.head}>
        <h1 className={styles.title}>训练</h1>
        <p className={styles.lede}>用真题练手：先自己做，再逐题看解析。</p>
      </header>

      <div
        className={styles.levelBar}
        ref={levelRef}
        data-stuck={levelStuck ? 'true' : 'false'}
      >
        <div className={styles.segments} role="tablist" aria-label="训练档位">
          {LEVELS.map((lv) => (
            <button
              key={lv.key}
              type="button"
              role="tab"
              aria-selected={level === lv.key}
              className={styles.segment}
              data-on={level === lv.key}
              onClick={() => setLevel(lv.key)}
            >
              {lv.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className={`${styles.hint} loading-pulse`}>读取中…</p>}
      {error && <p className={styles.hint}>{error}</p>}

      {!loading && !error && list.length === 0 && (
        <EmptyState title="这档还没有套卷" hint="题库按年份导入，换一档看看。" />
      )}

      {list.length > 0 && (
        <>
          <p className={styles.count}>{list.length} 套 · 点开按题型逐篇练</p>
          {years.map((year) => (
            <section key={year} className={styles.yearBlock}>
              <h2 className={styles.year}>{year}</h2>
              <ul className={styles.papers}>
                {(byYear.get(year) ?? []).map((p) => (
                  <li key={p.key}>
                    <button
                      type="button"
                      className={styles.paperRow}
                      onClick={() => openPaper(p.key)}
                    >
                      <span className={styles.paperText}>
                        <span className={styles.paperName}>{p.label}</span>
                        <span className={styles.paperMeta}>
                          {p.sections.length} 类题型 ·{' '}
                          {p.sections.reduce((n, s) => n + s.questions, 0)} 题
                        </span>
                      </span>
                      <span className={styles.chevron} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  )
}
