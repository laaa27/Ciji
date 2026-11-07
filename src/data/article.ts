import { Preferences } from '@capacitor/preferences'

import type { Article } from '@/domain/article'

/**
 * 文章存储：一天一篇，key = article:YYYY-MM-DD
 * 重新生成会覆盖当天那篇。
 */

const PREFIX = 'article:'

function key(date: string): string {
  return PREFIX + date
}

export async function saveArticle(article: Article): Promise<void> {
  await Preferences.set({
    key: key(article.date),
    value: JSON.stringify(article),
  })
}

export async function getArticle(date: string): Promise<Article | null> {
  const { value } = await Preferences.get({ key: key(date) })
  if (!value) return null
  try {
    return JSON.parse(value) as Article
  } catch {
    return null
  }
}

export async function deleteArticle(date: string): Promise<void> {
  await Preferences.remove({ key: key(date) })
}

/** 所有文章日期，倒序 */
export async function listArticleDates(): Promise<string[]> {
  const { keys } = await Preferences.keys()
  return keys
    .filter((k) => k.startsWith(PREFIX))
    .map((k) => k.slice(PREFIX.length))
    .sort()
    .reverse()
}

/** 全部文章（含正文），按日期倒序 */
export async function getAllArticles(): Promise<Article[]> {
  const dates = await listArticleDates()
  const out: Article[] = []
  for (const d of dates) {
    const a = await getArticle(d)
    if (a) out.push(a)
  }
  return out
}

/** 只要元信息，用于往期列表 —— 不用把正文全读出来 */
export async function listArticleSummaries(): Promise<
  { date: string; title: string; wordCount: number }[]
> {
  const dates = await listArticleDates()
  const out: { date: string; title: string; wordCount: number }[] = []
  for (const d of dates) {
    const a = await getArticle(d)
    if (!a) continue
    out.push({
      date: a.date,
      title: a.title,
      wordCount: a.sentences.reduce(
        (n, s) => n + (s.en.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0),
        0,
      ),
    })
  }
  return out
}
