import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

import { listFullArticles } from '@/data/article'
import { listGlossAlt } from '@/data/gloss'
import { getAllReadingDays } from '@/data/reading'
import { getAllDays } from '@/data/store'
import { listScores } from '@/data/training'
import { buildBackup, type BackupGloss } from '@/domain/backup'

/**
 * 导出与分享。
 *
 * 0.24.30 起只保留「全量备份 JSON」。CSV / Markdown 是给人看的派生物，
 * 却各自带着一套生成逻辑与测试，导回来还会丢学习时长与逐词反馈 ——
 * 与其维护两条半残的通道，不如把「能原样导回」这一条做扎实。
 */

/**
 * 导出并唤起系统分享。
 * 原生：写入缓存目录后分享文件；浏览器：直接下载。
 */
export async function exportFile(
  filename: string,
  content: string,
  mime = 'text/plain;charset=utf-8',
): Promise<void> {
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

  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 全量备份（JSON）：学习记录、生成文章、阅读时长、自定义释义、训练成绩。
 * 与「导出一份报表」不同，这份文件的目的是**导回来和导出前一致**。
 *
 * 不进去的两类：主释义缓存（可达 3000 条、可再生）、AI 备选释义（可再生且要花额度）。
 */
export async function exportBackup(): Promise<string> {
  const [days, articles, readingDays, altMap, scores] = await Promise.all([
    getAllDays(),
    listFullArticles(),
    getAllReadingDays(),
    listGlossAlt(),
    // 同步读 localStorage，包一层只是为了让上面几个并发
    Promise.resolve(listScores()),
  ])

  const reading: Record<string, number> = {}
  for (const { date, seconds } of readingDays) reading[date] = seconds

  // 只带用户手填的那一条：AI 备选可再生，不该占用备份体积
  const glossAlt: Record<string, BackupGloss> = {}
  for (const [word, alt] of Object.entries(altMap)) {
    const custom = alt.custom?.trim()
    if (custom) glossAlt[word] = { custom }
  }

  const backup = buildBackup(days, articles, { reading, glossAlt, scores })
  const stamp = new Date().toISOString().slice(0, 10)
  const content = JSON.stringify(backup, null, 2)

  await exportFile(`词迹备份-${stamp}.json`, content, 'application/json;charset=utf-8')
  const counts = [
    `${days.length} 天记录`,
    `${articles.length} 篇文章`,
    `${readingDays.length} 天阅读时长`,
    `${Object.keys(glossAlt).length} 条自定义释义`,
    `${Object.keys(scores).length} 条成绩`,
  ]
  return `${counts.join('、')}已导出`
}
