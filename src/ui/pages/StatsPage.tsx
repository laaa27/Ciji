import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

import { getAllDays } from '@/data/store'
import { getAllReadingDays, type ReadingDay } from '@/data/reading'
import { useTheme } from '@/store/theme'
import { lineState, type TodaySnapshot, type WordState } from '@/domain/collect'
import { monthDay } from '@/lib/date'

import EmptyState from '../components/EmptyState'
import styles from './StatsPage.module.css'

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

type Row = {
  date: string
  label: string
  new: number
  vague: number
  forget: number
}

function buildRows(days: TodaySnapshot[]): Row[] {
  return days
    .slice()
    .reverse()
    .map((d) => {
      // 堆叠柱需要互斥，否则同一根柱子会重复计数；用竖线口径（按反馈）最直观
      const c: Record<WordState, number> = { new: 0, vague: 0, forget: 0 }
      for (const w of d.words) c[lineState(w)] += 1
      const [, m, day] = d.date.split('-')
      return {
        date: d.date,
        label: `${Number(m)}/${Number(day)}`,
        new: c.new,
        vague: c.vague,
        forget: c.forget,
      }
    })
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** 秒数 → 「3 分 20 秒」这种给人看的说法 */
function fmtMinutes(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m === 0) return `${s} 秒`
  return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`
}

type ReadRow = { label: string; minutes: number }

function buildReadRows(days: ReadingDay[]): ReadRow[] {
  return days
    .slice()
    .reverse()
    .map((d) => {
      const [, m, day] = d.date.split('-')
      return {
        label: `${Number(m)}/${Number(day)}`,
        // 图表按分钟画，保留一位小数，短阅读也能在图上站得住
        minutes: Math.round((d.seconds / 60) * 10) / 10,
      }
    })
}

function ReadingChart({ rows }: { rows: ReadRow[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useTheme((s) => s.theme)

  useEffect(() => {
    if (!ref.current) return

    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    const ink = cssVar('--ink', '#16181a')
    const ink3 = cssVar('--ink-3', '#8c918d')
    const rule = cssVar('--rule', '#e4e7e0')

    chart.setOption({
      animationDuration: 500,
      grid: { left: 0, right: 0, top: 8, bottom: 18, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: cssVar('--surface', '#ffffff'),
        borderColor: rule,
        borderWidth: 1,
        textStyle: { color: ink, fontSize: 12 },
        padding: [8, 10],
        valueFormatter: (v: unknown) => `${v} 分钟`,
      },
      xAxis: {
        type: 'category',
        data: rows.map((r) => r.label),
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false },
        axisLabel: {
          color: ink3,
          fontSize: 10,
          interval: Math.max(0, Math.floor(rows.length / 6) - 1),
          margin: 8,
        },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: rule, type: 'dotted' } },
        axisLabel: { color: ink3, fontSize: 10 },
      },
      series: [
        {
          name: '阅读',
          type: 'bar',
          data: rows.map((r) => r.minutes),
          itemStyle: { color: cssVar('--accent', '#16181a') },
          barMaxWidth: 14,
        },
      ],
    })

    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
    }
  }, [rows, theme])

  return <div ref={ref} className={styles.chart} />
}

function TrendChart({ rows }: { rows: Row[] }) {
  const ref = useRef<HTMLDivElement>(null)
  // 颜色在 init 时从 CSS 变量读一次，换主题必须重建，否则图表还是旧配色
  const theme = useTheme((s) => s.theme)

  useEffect(() => {
    if (!ref.current) return

    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    const ink = cssVar('--ink', '#16181a')
    const ink3 = cssVar('--ink-3', '#8c918d')
    const rule = cssVar('--rule', '#e4e7e0')

    chart.setOption({
      animationDuration: 500,
      grid: { left: 0, right: 0, top: 8, bottom: 18, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: cssVar('--surface', '#ffffff'),
        borderColor: rule,
        borderWidth: 1,
        textStyle: { color: ink, fontSize: 12 },
        padding: [8, 10],
      },
      xAxis: {
        type: 'category',
        data: rows.map((r) => r.label),
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false },
        axisLabel: {
          color: ink3,
          fontSize: 10,
          interval: Math.max(0, Math.floor(rows.length / 6) - 1),
          margin: 8,
        },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: rule, type: 'dotted' } },
        axisLabel: { color: ink3, fontSize: 10 },
      },
      series: [
        {
          name: '新学',
          type: 'bar',
          stack: 'total',
          data: rows.map((r) => r.new),
          itemStyle: { color: cssVar('--state-new', '#2a5580') },
          barMaxWidth: 14,
        },
        {
          name: '模糊',
          type: 'bar',
          stack: 'total',
          data: rows.map((r) => r.vague),
          itemStyle: { color: cssVar('--state-vague', '#8f5f1c') },
          barMaxWidth: 14,
        },
        {
          name: '忘记',
          type: 'bar',
          stack: 'total',
          data: rows.map((r) => r.forget),
          itemStyle: { color: cssVar('--state-forget', '#9c332a') },
          barMaxWidth: 14,
        },
      ],
    })

    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
    }
  }, [rows, theme])

  return <div ref={ref} className={styles.chart} />
}

export default function StatsPage() {
  const [days, setDays] = useState<TodaySnapshot[]>([])
  const [reads, setReads] = useState<ReadingDay[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void Promise.all([getAllDays(), getAllReadingDays()]).then(([dayList, readList]) => {
      if (!alive) return
      setDays(dayList)
      setReads(readList)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  const rows = useMemo(() => buildRows(days).slice(-30), [days])

  // 阅读时长：和词量趋势分开一张图，口径不同（分钟 vs 词数）放一起只会互相压扁
  const readRows = useMemo(() => buildReadRows(reads).slice(-30), [reads])

  const readTotal = useMemo(
    () => reads.reduce((acc, d) => acc + d.seconds, 0),
    [reads],
  )

  const summary = useMemo(() => {
    let newCount = 0
    let vagueCount = 0
    let forgetCount = 0
    // 摘要用真实口径，允许重叠：一个新学且忘记的词，两个数都要算进去
    for (const d of days) {
      for (const w of d.words) {
        if (w.isNew) newCount += 1
        if (w.firstResponse === 'VAGUE') vagueCount += 1
        if (w.firstResponse === 'FORGET') forgetCount += 1
      }
    }
    return { newCount, vagueCount, forgetCount, days: days.length }
  }, [days])

  const stubborn = useMemo(() => {
    const map = new Map<string, number>()
    for (const d of days) {
      for (const w of d.words) {
        if (w.firstResponse !== 'FORGET') continue
        const key = w.spelling.toLowerCase()
        map.set(key, (map.get(key) ?? 0) + 1)
      }
    }
    return [...map.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
  }, [days])

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>统计</h1>

      {loading && <p className={`${styles.hint} loading-pulse`}>读取中…</p>}

      {!loading && days.length === 0 && (
        <EmptyState title="数据还不够" hint="积累几天之后，这里会呈现你的遗忘曲线。" />
      )}

      {!loading && days.length > 0 && (
        <>
          <p className={styles.summary}>
            记录的 {summary.days} 天里，
            <br />
            新学 <strong data-state="new">{summary.newCount}</strong> 个词，
            有 <strong data-state="vague">{summary.vagueCount}</strong> 次模糊，
            <strong data-state="forget">{summary.forgetCount}</strong> 次忘记。
          </p>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>最近 30 天</h2>
            <TrendChart rows={rows} />
          </section>

          {readRows.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>阅读时长</h2>
              <ReadingChart rows={readRows} />
              <p className={styles.hint}>
                累计 {readRows.length} 天，共 {fmtMinutes(readTotal)}。最近一天是{' '}
                {monthDay(reads[0].date)}，读了 {fmtMinutes(reads[0].seconds)}。
              </p>
            </section>
          )}

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>反复忘记</h2>
            {stubborn.length === 0 ? (
              <p className={styles.hint}>还没有重复忘记的词。</p>
            ) : (
              <ul className={styles.list}>
                {stubborn.map(([word, n]) => (
                  <li key={word} className={styles.listItem}>
                    <span className={styles.listWord}>{word}</span>
                    <span className={styles.listCount}>{n} 次</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
