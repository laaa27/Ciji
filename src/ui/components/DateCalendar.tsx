import { useMemo, useState } from 'react'

import { daysInMonth, firstWeekday, monthDay, weekday, yearMonth } from '@/lib/date'

import BackButton from './BackButton'
import styles from './DateCalendar.module.css'

/** 周日开头，与国内日历一致 */
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

type Props = {
  /** 当前选中的日期（YYYY-MM-DD） */
  value: string
  /** 有学习记录的日期 —— 只有这些格子能点 */
  days: Set<string>
  today: string
  onPick: (date: string) => void
  onBack: () => void
}

/** YYYY-MM 加减月份 */
function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1, 4))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * 选日期（生成页的二级页）。
 *
 * 快捷日期条只放最近 7 天有记录的日子，再往前的只能从这里翻 ——
 * 所以这一页的职责是「把有没有记录说清楚」：能点的用正文黑，没有记录的置灰且不可点，
 * 而不是点下去才发现是空的。
 */
export default function DateCalendar({ value, days, today, onPick, onBack }: Props) {
  // 打开时停在当前选中日所在的月份
  const [ym, setYm] = useState(() => value.slice(0, 7))
  const [y, m] = ym.split('-').map(Number)

  /** 首行空出的格子用 null 占位，避免 1 号错位到别的星期 */
  const cells = useMemo(() => {
    const out: (string | null)[] = Array.from({ length: firstWeekday(y, m) }, () => null)
    for (let d = 1; d <= daysInMonth(y, m); d += 1) {
      out.push(`${ym}-${String(d).padStart(2, '0')}`)
    }
    return out
  }, [y, m, ym])

  // 没有未来可言：翻到今天所在的月份就够了
  const atLatest = ym >= today.slice(0, 7)

  return (
    <>
      <header className={styles.header}>
        <BackButton onClick={onBack} />
        <h1 className={styles.title}>选择日期</h1>
      </header>

      <div className={styles.monthBar}>
        <button
          type="button"
          className={styles.arrow}
          onClick={() => setYm(shiftMonth(ym, -1))}
          aria-label="上个月"
        >
          <span className={styles.chev} data-dir="left" aria-hidden="true" />
        </button>
        <span className={styles.monthLabel}>{yearMonth(ym)}</span>
        <button
          type="button"
          className={styles.arrow}
          onClick={() => setYm(shiftMonth(ym, 1))}
          disabled={atLatest}
          aria-label="下个月"
        >
          <span className={styles.chev} data-dir="right" aria-hidden="true" />
        </button>
      </div>

      <div className={styles.weekRow} aria-hidden="true">
        {WEEK.map((w) => (
          <span key={w} className={styles.weekName}>
            {w}
          </span>
        ))}
      </div>

      <div className={styles.grid}>
        {cells.map((key, i) =>
          key === null ? (
            <span key={`blank-${i}`} className={styles.blank} />
          ) : (
            <button
              key={key}
              type="button"
              className={styles.cell}
              data-has={days.has(key) ? 'true' : 'false'}
              data-on={key === value ? 'true' : 'false'}
              data-today={key === today ? 'true' : 'false'}
              disabled={!days.has(key)}
              aria-label={`${monthDay(key)} ${weekday(key)}${days.has(key) ? '' : '，没有记录'}`}
              onClick={() => onPick(key)}
            >
              {Number(key.slice(8))}
            </button>
          ),
        )}
      </div>

      <p className={styles.hint}>只有留有学习记录的日期可以选，灰色的那些那天没打开过。</p>
    </>
  )
}
