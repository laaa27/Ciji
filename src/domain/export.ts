import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

import { lookupWords } from '@/data/dict'
import { getAllDays } from '@/data/store'
import type { TodaySnapshot, WordState } from '@/domain/collect'

const STATE_LABEL: Record<WordState, string> = {
  new: '新学',
  vague: '模糊',
  forget: '忘记',
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** 生成 CSV：日期,单词,类型,释义 */
export function buildCSV(
  days: TodaySnapshot[],
  glosses: Map<string, string>,
): string {
  const lines = ['日期,单词,类型,释义']
  for (const day of days) {
    for (const w of day.words) {
      const gloss = glosses.get(w.spelling.toLowerCase()) ?? ''
      lines.push(
        [
          day.date,
          csvCell(w.spelling),
          STATE_LABEL[w.state],
          csvCell(gloss),
        ].join(','),
      )
    }
  }
  return lines.join('\n')
}

/** 生成 Markdown：按日期分组 */
export function buildMarkdown(
  days: TodaySnapshot[],
  glosses: Map<string, string>,
): string {
  const out: string[] = ['# 词迹 · 学习记录', '']

  for (const day of days) {
    if (day.words.length === 0) continue
    out.push(`## ${day.date}`, '')

    for (const state of ['new', 'vague', 'forget'] as WordState[]) {
      const items = day.words.filter((w) => w.state === state)
      if (items.length === 0) continue
      out.push(`**${STATE_LABEL[state]}**（${items.length}）`, '')
      for (const w of items) {
        const gloss = glosses.get(w.spelling.toLowerCase())
        out.push(gloss ? `- ${w.spelling} — ${gloss}` : `- ${w.spelling}`)
      }
      out.push('')
    }
  }

  return out.join('\n')
}

/** 收集全部词条释义 */
export async function collectGlosses(days: TodaySnapshot[]): Promise<Map<string, string>> {
  const spellings = new Set<string>()
  for (const day of days) {
    for (const w of day.words) spellings.add(w.spelling)
  }
  return lookupWords([...spellings])
}

/**
 * 导出并唤起系统分享。
 * 原生：写入缓存目录后分享文件；浏览器：直接下载。
 */
export async function exportFile(filename: string, content: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.writeFile({
      path: filename,
      data: content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    })
    await Share.share({ title: filename, url: uri, dialogTitle: '导出学习记录' })
    return
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function exportAll(format: 'csv' | 'md'): Promise<string> {
  const days = await getAllDays()
  const glosses = await collectGlosses(days)
  const stamp = new Date().toISOString().slice(0, 10)

  if (format === 'csv') {
    const content = buildCSV(days, glosses)
    await exportFile(`词迹-${stamp}.csv`, content)
    return `${days.length} 天的记录已导出`
  }

  const content = buildMarkdown(days, glosses)
  await exportFile(`词迹-${stamp}.md`, content)
  return `${days.length} 天的记录已导出`
}
