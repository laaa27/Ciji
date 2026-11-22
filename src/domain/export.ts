import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

import { listFullArticles } from '@/data/article'
import { getAllDays } from '@/data/store'
import { buildBackup } from '@/domain/backup'

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
 */
export async function exportBackup(): Promise<string> {
  const days = await getAllDays()
  const articles = await listFullArticles()
  const backup = buildBackup(days, articles)
  const stamp = new Date().toISOString().slice(0, 10)
  const content = JSON.stringify(backup, null, 2)

  await exportFile(`词迹备份-${stamp}.json`, content, 'application/json;charset=utf-8')
  return `${days.length} 天、${articles.length} 篇文章的备份已导出`
}
