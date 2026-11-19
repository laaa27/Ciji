import { useEffect, useMemo, useRef, useState } from 'react'

import { getAllDays } from '@/data/store'
import { lookupWords } from '@/domain/lookup'
import { groupCounts, lineState, responseNote, type TodaySnapshot, type WordState } from '@/domain/collect'
import { monthDay, weekday } from '@/lib/date'

import { useGlossToggle } from '../hooks/useGlossToggle'
import { useSubView } from '../hooks/useSubView'
import { findScrollParent, useScrollStuck } from '../hooks/useScrollStuck'
import WordRow from '../components/WordRow'
import EmptyState from '../components/EmptyState'
import StatsPage from './StatsPage'
import BackButton from '../components/BackButton'
import styles from './HistoryPage.module.css'

const ORDER: WordState[] = ['new', 'vague', 'forget']
const TITLE: Record<WordState, string> = { new: '新学', vague: '模糊', forget: '忘记' }


function DayItem({
  day,
  open,
  onToggle,
  isGlossShown,
  toggleGloss,
}: {
  day: TodaySnapshot
  open: boolean
  onToggle: () => void
  /** 某个词最终该不该展开（总闸 + 单次覆盖已在 hook 里合并） */
  isGlossShown: (vocId: string) => boolean
  toggleGloss: (vocId: string) => void
}) {
  const counts = useMemo(() => groupCounts(day.words), [day.words])
  const total = day.words.length

  const [glosses, setGlosses] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open || day.words.length === 0) return
    let alive = true
    const merge = (m: Map<string, string>) => {
      if (!alive) return
      setGlosses((prev) => ({ ...prev, ...Object.fromEntries(m) }))
    }
    void lookupWords(day.words.map((w) => w.spelling), { onLocal: merge }).then((res) =>
      merge(res.glosses),
    )
    return () => {
      alive = false
    }
  }, [open, day])

  return (
    <li className={styles.item}>
      <button type="button" className={styles.head} onClick={onToggle} aria-expanded={open}>
        <span className={styles.date}>{monthDay(day.date)}</span>
        <span className={styles.weekday}>{weekday(day.date)}</span>

        {total > 0 ? (
          <span className={styles.ratio} aria-hidden="true">
            {ORDER.map((k) =>
              counts[k] > 0 ? (
                <span
                  key={k}
                  data-state={k}
                  style={{ flexGrow: counts[k] }}
                />
              ) : null,
            )}
          </span>
        ) : (
          <span className={styles.ratio} />
        )}

        <span className={styles.total}>{total > 0 ? total : '—'}</span>
      </button>

      {open && (
        <div className={styles.detail}>
          {total === 0 ? (
            <p className={styles.none}>这天没有学习记录</p>
          ) : (
            ORDER.filter((k) => counts[k] > 0).map((k) => (
              <div key={k} className={styles.block}>
                <div className={styles.blockHead}>
                  {TITLE[k]}
                  <span>{counts[k]}</span>
                </div>
                <ul>
                  {day.words
                    .filter((w) => w.groups.includes(k))
                    .map((w) => (
                      <WordRow
                        key={`${k}-${w.vocId}`}
                        spelling={w.spelling}
                        gloss={glosses[w.spelling.toLowerCase()]}
                        state={lineState(w)}
                        note={responseNote(w)}
                        glossVisible={isGlossShown(w.vocId)}
                        onToggle={() => toggleGloss(w.vocId)}
                      />
                    ))}
                </ul>
              </div>
            ))
          )}
        </div>
      )}
    </li>
  )
}

/**
 * 本页的二级视图只有统计一个。
 *
 * 统计原先是底栏的一格，独立成页却和这里读的是同一份日期数据 ——
 * 看板和明细分成两个入口，用户在两边来回切，反而要记两次位置。
 * 收进来之后，底栏那一格留给训练。
 */
type Sub = 'stats'

export default function HistoryPage({ active }: { active: boolean }) {
  const [days, setDays] = useState<TodaySnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<string | null>(null)
  /** 释义展开：总闸 + 单个词的临时覆盖（默认收起，与今日页一致） */
  const gloss = useGlossToggle('glossHistory')

  const pageRef = useRef<HTMLDivElement>(null)
  /** 进统计之前列表停在哪 —— 返回时要回到原处 */
  const listScroll = useRef(0)
  /** 标题行吸顶：贴住了才画分隔线 */
  const titleRef = useRef<HTMLElement>(null)
  const titleStuck = useScrollStuck(titleRef)

  const sub = useSubView<Sub>({
    onEnter: () => {
      const scroller = findScrollParent(pageRef.current)
      if (scroller) listScroll.current = scroller.scrollTop
    },
  })

  useEffect(() => {
    let alive = true
    void getAllDays().then((list) => {
      if (!alive) return
      setDays(list)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  // 进出统计时重置/恢复滚动：看板从顶部看，返回时接着刚才的日期往下翻。
  // 位置为 0 就不恢复 —— 首帧那次 effect 不能去动 App 记下来的栏目位置。
  useEffect(() => {
    const scroller = findScrollParent(pageRef.current)
    if (!scroller) return

    if (sub.isOpen) {
      scroller.scrollTop = 0
      return
    }
    if (listScroll.current <= 0) return

    const raf = requestAnimationFrame(() => {
      scroller.scrollTop = listScroll.current
    })
    return () => cancelAnimationFrame(raf)
  }, [sub.isOpen])

  if (sub.view === 'stats') {
    return (
      <div className={styles.page} data-view="stats" ref={pageRef}>
        <header className={styles.subHead}>
          <BackButton onClick={sub.close} />
          <h1 className={styles.subTitle}>统计</h1>
        </header>

        <StatsPage active={active} />
      </div>
    )
  }

  return (
    <div className={styles.page} data-return={sub.returning ? 'true' : 'false'} ref={pageRef}>
      <header
        className={styles.titleRow}
        ref={titleRef}
        data-stuck={titleStuck ? 'true' : 'false'}
      >
        <h1 className={styles.title}>历史</h1>

        <div className={styles.actions}>
          {/*
            统计入口不跟「有没有记录」走：没有学习记录时它还有阅读时长可看，
            而释义按钮没有词就无事可做。
          */}
          <button type="button" className={styles.entry} onClick={() => sub.open('stats')}>
            统计
            <span className={styles.chevron} aria-hidden="true" />
          </button>
          {days.length > 0 && (
            <button
              type="button"
              className={styles.entry}
              data-on={gloss.showGloss}
              onClick={gloss.toggleAll}
            >
              释义
            </button>
          )}
        </div>
      </header>

      {loading && <p className={`${styles.hint} loading-pulse`}>读取中…</p>}

      {!loading && days.length === 0 && (
        <EmptyState title="还没有记录" hint="每天打开一次，这里会按日期攒下你的词。" />
      )}

      {!loading && days.length > 0 && (
        <ul className={styles.list}>
          {days.map((day) => (
            <DayItem
              key={day.date}
              day={day}
              open={open === day.date}
              onToggle={() => setOpen(open === day.date ? null : day.date)}
              isGlossShown={gloss.isShown}
              toggleGloss={gloss.toggle}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
