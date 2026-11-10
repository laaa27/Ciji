import { Preferences } from '@capacitor/preferences'

import type { Article } from '@/domain/article'
import { countWordsIn } from '@/lib/text'

/**
 * 文章存储。每次生成都留档，不覆盖。
 *
 * 两个 key：
 * - article:<id>      全文，id 形如 2026-11-07#2
 * - article_index    元信息列表（日期/标题/词数），列表页只读这个
 *
 * 为什么要索引：单篇约 5.5KB，一千篇就是 5MB，
 * 每次列表都把全文读出来解析会卡好几秒。索引只有一百多字节一条。
 */

const PREFIX = 'article:'
const INDEX_KEY = 'article_index'

export interface ArticleMeta {
  id: string
  date: string
  title: string
  wordCount: number
  createdAt: string
}

function sortMetas(list: ArticleMeta[]): ArticleMeta[] {
  return list.sort(
    (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
  )
}

async function writeIndex(list: ArticleMeta[]): Promise<void> {
  await Preferences.set({ key: INDEX_KEY, value: JSON.stringify(list) })
}

/**
 * 读索引。索引不存在时（首次升级、或早期版本只存了 article:<date>），
 * 从现有的 article:* key 重建一次。
 */
async function readIndex(): Promise<ArticleMeta[]> {
  const { value } = await Preferences.get({ key: INDEX_KEY })
  if (value) {
    try {
      const parsed = JSON.parse(value) as ArticleMeta[]
      if (Array.isArray(parsed)) return parsed
    } catch {
      // 落到重建
    }
  }

  const { keys } = await Preferences.keys()
  const ids = keys.filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length))

  const list: ArticleMeta[] = []
  for (const id of ids) {
    const a = await getArticleById(id)
    if (!a) continue
    list.push({
      id,
      date: a.date,
      title: a.title,
      wordCount: countWordsIn(a.sentences),
      createdAt: a.createdAt,
    })
  }

  const sorted = sortMetas(list)
  if (sorted.length > 0) await writeIndex(sorted)
  return sorted
}

export async function getArticleById(id: string): Promise<Article | null> {
  const { value } = await Preferences.get({ key: PREFIX + id })
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Article
    // 早期版本的文章没有 id 字段，读出来补上
    return parsed.id ? parsed : { ...parsed, id }
  } catch {
    return null
  }
}

/** 保存一篇文章。没有 id 时自动按「当天第几篇」编号，返回带 id 的副本。 */
export async function saveArticle(article: Article): Promise<Article> {
  const index = await readIndex()

  let id = article.id
  if (!id) {
    const sameDay = index.filter((a) => a.date === article.date).length
    id = `${article.date}#${sameDay + 1}`
  }

  const saved: Article = { ...article, id }
  await Preferences.set({
    key: PREFIX + id,
    value: JSON.stringify(saved),
  })

  const meta: ArticleMeta = {
    id,
    date: saved.date,
    title: saved.title,
    wordCount: countWordsIn(saved.sentences),
    createdAt: saved.createdAt,
  }

  const next = sortMetas([meta, ...index.filter((a) => a.id !== id)])
  await writeIndex(next)

  return saved
}

export async function deleteArticle(id: string): Promise<void> {
  await Preferences.remove({ key: PREFIX + id })
  const index = await readIndex()
  await writeIndex(index.filter((a) => a.id !== id))
}

/** 文章库列表，按日期与时间倒序 */
export async function listArticles(): Promise<ArticleMeta[]> {
  return readIndex()
}

/**
 * 今天已经生成过的文章覆盖了哪些词。
 * 生成新文章时排除这些词，避免同一天反复用同一批；
 * 到了第二天会重新可用 —— 又忘了的词还能再复习一遍。
 */
export async function getCoveredWordsToday(date: string): Promise<Set<string>> {
  const index = await readIndex()
  const ids = index.filter((a) => a.date === date).map((a) => a.id)

  const covered = new Set<string>()
  for (const id of ids) {
    const a = await getArticleById(id)
    if (!a) continue
    // 用户在生成页点了「清除当天已用记录」的文章不算覆盖，那些词恢复默认可选
    if (a.skipCoverage) continue
    for (const w of a.targetWords) covered.add(w.toLowerCase())
  }
  return covered
}

/**
 * 把某天所有文章标记为「不计入已用」（生成页「清除当天已用记录」按钮）。
 * 文章本身保留，可继续阅读；返回实际标记了几篇。
 */
export async function markDayCoverageSkipped(date: string): Promise<number> {
  const index = await readIndex()
  const ids = index.filter((a) => a.date === date).map((a) => a.id)

  let marked = 0
  for (const id of ids) {
    const a = await getArticleById(id)
    if (!a || a.skipCoverage) continue
    await saveArticle({ ...a, skipCoverage: true })
    marked += 1
  }
  return marked
}

/** 某天最后一篇，用于打开阅读页时默认展示 */
export async function getLatestArticleOfDay(date: string): Promise<Article | null> {
  const index = await readIndex()
  const sameDay = index.filter((a) => a.date === date)
  if (sameDay.length === 0) return null
  return getArticleById(sameDay[0].id)
}
