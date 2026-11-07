import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

import { getAllDays } from '@/data/store'
import type { TodaySnapshot, WordState } from '@/domain/collect'

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
      const c: Record<WordState, number> = { new: 0, vague: 0, forget: 0 }
      for (const w of d.words) c[w.state] += 1
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

function TrendChart({ rows }: { rows: Row[] }) {
  const ref = useRef<HTMLDivElement>(null)

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
        backgroundColor: '#ffffff',
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
  }, [rows])

  return <div ref={ref} className={styles.chart} />
}

export default function StatsPage() {
  const [days, setDays] = useState<TodaySnapshot[]>([])
  const [loading, setLoading] = useState(true)

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

  const rows = useMemo(() => buildRows(days).slice(-30), [days])

  const summary = useMemo(() => {
    let newCount = 0
    let vagueCount = 0
    let forgetCount = 0
    for (const d of days) {
      for (const w of d.words) {
        if (w.state === 'new') newCount += 1
        else if (w.state === 'vague') vagueCount += 1
        else forgetCount += 1
      }
    }
    return { newCount, vagueCount, forgetCount, days: days.length }
  }, [days])

  const stubborn = useMemo(() => {
    const map = new Map<string, number>()
    for (const d of days) {
      for (const w of d.words) {
        if (w.state !== 'forget') continue
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

      {loading && <p className={styles.hint}>读取中…</p>}

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
