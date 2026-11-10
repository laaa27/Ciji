import { useEffect, useMemo, useState } from 'react'

import { getAllDays } from '@/data/store'
import { lookupWords } from '@/data/dict'
import { lineState, responseNote, type TodaySnapshot, type WordState } from '@/domain/collect'
import { monthDay, weekday } from '@/lib/date'

import { useGlossToggle } from '../hooks/useGlossToggle'
import WordRow from '../components/WordRow'
import EmptyState from '../components/EmptyState'
import styles from './HistoryPage.module.css'

const ORDER: WordState[] = ['new', 'vague', 'forget']
const TITLE: Record<WordState, string> = { new: '新学', vague: '模糊', forget: '忘记' }

type Counts = Record<WordState, number>

function countBy(words: TodaySnapshot['words']): Counts {
  const c: Counts = { new: 0, vague: 0, forget: 0 }
  // 多归属：一个新学且忘记的词两组都算
  for (const w of words) for (const g of w.groups) c[g] += 1
  return c
}

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
  const counts = useMemo(() => countBy(day.words), [day.words])
  const total = day.words.length

  const [glosses, setGlosses] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open || day.words.length === 0) return
    let alive = true
    const merge = (m: Map<string, string>) => {
      if (!alive) return
      setGlosses((prev) => ({ ...prev, ...Object.fromEntries(m) }))
    }
    void lookupWords(day.words.map((w) => w.spelling), { onLocal: merge }).then(merge)
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

export default function HistoryPage() {
  const [days, setDays] = useState<TodaySnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<string | null>(null)
  /** 释义展开：总闸 + 单个词的临时覆盖（默认收起，与今日页一致） */
  const gloss = useGlossToggle('glossHistory')

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

  return (
    <div className={styles.page}>
      <header className={styles.titleRow}>
        <h1 className={styles.title}>历史</h1>
        {days.length > 0 && (
          <button
            type="button"
            className={styles.glossToggle}
            data-on={gloss.showGloss}
            onClick={gloss.toggleAll}
          >
            释义
          </button>
        )}
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
