import { useEffect, useRef, useState } from 'react'

import { loadTrainingIndex, loadTrainingPaper } from '@/data/training'
import {
  LEVELS,
  type TrainingIndexItem,
  type TrainingLevel,
  type TrainingPaper,
} from '@/domain/training'

import { findScrollParent } from '../hooks/useScrollStuck'
import { useSubView } from '../hooks/useSubView'
import EmptyState from '../components/EmptyState'
import TrainingDoc from '../components/TrainingDoc'
import styles from './TrainingPage.module.css'

/**
 * 训练页：档位 → 套卷 → 篇目 → 做题。
 *
 * 数据是打进包里的静态 JSON（`public/training/`），由 scripts/import-training.py 生成。
 * 这一页只负责挑卷与切层，做题界面在 `components/TrainingDoc.tsx`。
 *
 * 两层二级视图（套卷详情 / 做题）各用一个 useSubView：返回动画与安卓返回键
 * 都由 hook 接管，后进先出正好是「先退做题、再退套卷」。
 */
export default function TrainingPage() {
  const [level, setLevel] = useState<TrainingLevel>('cet4')
  const [index, setIndex] = useState<TrainingIndexItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [paper, setPaper] = useState<TrainingPaper | null>(null)
  const [paperError, setPaperError] = useState<string | null>(null)

  const pageRef = useRef<HTMLDivElement>(null)
  /** 进下一层之前列表停在哪 */
  const rootScroll = useRef(0)
  const paperScroll = useRef(0)

  const paperNav = useSubView<string>()
  const docNav = useSubView<string>()

  useEffect(() => {
    let alive = true
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
    const s = scroller()
    if (s) rootScroll.current = s.scrollTop
    setPaper(null)
    setPaperError(null)
    paperNav.open(key)
    toTop()
    void loadTrainingPaper(key)
      .then(setPaper)
      .catch((e: unknown) => setPaperError(e instanceof Error ? e.message : '套卷读取失败'))
  }

  function closePaper() {
    paperNav.close()
    restore(rootScroll)
  }

  function openDoc(passageId: string) {
    const s = scroller()
    if (s) paperScroll.current = s.scrollTop
    docNav.open(passageId)
    toTop()
  }

  function closeDoc() {
    docNav.close()
    restore(paperScroll)
  }

  const list = index.filter((p) => p.level === level)

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
        <div className={styles.page} data-view="doc" ref={pageRef}>
          <header className={styles.subHead}>
            <button type="button" className={styles.back} onClick={closeDoc}>
              返回
            </button>
            <h1 className={styles.subTitle}>{section.label}</h1>
          </header>
          <TrainingDoc paper={paper} section={section} passage={section.passages[pi]} index={pi} />
        </div>
      )
    }
  }

  // ---- 套卷详情 ----
  if (paperNav.view) {
    return (
      <div className={styles.page} data-view="paper" ref={pageRef}>
        <header className={styles.subHead}>
          <button type="button" className={styles.back} onClick={closePaper}>
            返回
          </button>
          <h1 className={styles.subTitle}>{paper?.label ?? '套卷'}</h1>
        </header>

        {paperError && <p className={styles.hint}>{paperError}</p>}
        {!paper && !paperError && <p className={`${styles.hint} loading-pulse`}>读取中…</p>}

        {paper && (
          <ul className={styles.sections}>
            {paper.sections.map((sec) =>
              sec.passages.map((p, i) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={styles.passageRow}
                    onClick={() => openDoc(p.id)}
                  >
                    <span className={styles.passageText}>
                      <span className={styles.passageName}>
                        {sec.label}
                        {sec.passages.length > 1 ? ` · 第 ${i + 1} 篇` : ''}
                      </span>
                      <span className={styles.passageMeta}>
                        {p.questions.length} 题
                        {sec.id === 'listening' ? ' · 音频暂缺' : ''}
                      </span>
                    </span>
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
