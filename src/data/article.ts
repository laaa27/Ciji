import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
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

/* ── 文章正文的独立文件存储（0.24.22）──────────────────
 *
 * 为什么搬：所有 Preferences 键共用一个 XML、每次写全量重写——文章是其中
 * 最大的一块（5.5KB/篇），留在里面会让全文件的读写成本跟着文章数涨。
 * 每篇一个 JSON 文件（Directory.Data 下 articles/ 子目录）之后，
 * 写一篇只写一个小文件，与释义、每日记录所在的存储彻底分家。
 *
 * Filesystem 的 web 实现走 IndexedDB，两端语义一致，不需要平台分支。
 * 索引（article_index）仍留在 Preferences——它很小，且列表页只读它。
 */

const ART_SUBDIR = 'articles'

/** 文章正文放 App 私有文件区；Filesystem 的 web 实现走 IndexedDB，两端语义一致 */
const ART_DIR = Directory.Data

function articlePath(id: string): string {
  return `${ART_SUBDIR}/${id}.json`
}

async function writeArticleFile(id: string, article: Article): Promise<void> {
  await Filesystem.writeFile({
    path: articlePath(id),
    directory: Directory.Data,
    data: JSON.stringify(article),
    encoding: Encoding.UTF8,
    recursive: true,
  })
}

async function readArticleFile(id: string): Promise<Article | null> {
  try {
    const { data } = await Filesystem.readFile({
      path: articlePath(id),
      directory: ART_DIR,
      encoding: Encoding.UTF8,
    })
    const parsed = JSON.parse(data as string) as Article
    return parsed.id === id ? parsed : null
  } catch {
    return null
  }
}

async function removeArticleFile(id: string): Promise<void> {
  try {
    await Filesystem.deleteFile({ path: articlePath(id), directory: ART_DIR })
  } catch {
    // 文件不存在 = 目标状态已达成
  }
}

/**
 * 一次性迁移：把还留在 Preferences 里的旧文章搬到独立文件，搬成功才删旧键。
 * 每个会话只跑一次；失败时把标记退回去，下次启动重试。部分迁移是安全的：
 * 读取时文件优先、旧键兜底，两边哪个有数据都能读出来。
 */
let legacySwept = false

async function sweepLegacyArticles(): Promise<void> {
  if (legacySwept) return
  legacySwept = true
  try {
    const { keys } = await Preferences.keys()
    const legacyKeys = keys.filter((k) => k.startsWith(PREFIX))
    for (const key of legacyKeys) {
      const id = key.slice(PREFIX.length)
      if (await readArticleFile(id)) {
        // 文件里已经有了（上次迁移中断的残留），旧键直接清
        await Preferences.remove({ key }).catch(() => {})
        continue
      }
      const legacy = await readLegacyArticle(id)
      if (!legacy) continue
      await writeArticleFile(id, legacy)
      await Preferences.remove({ key }).catch(() => {})
    }
  } catch {
    legacySwept = false
  }
}

/** 旧路径：从 Preferences 读单篇（迁移前的存储） */
async function readLegacyArticle(id: string): Promise<Article | null> {
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

export async function getArticleById(id: string): Promise<Article | null> {
  // 文件优先；文件不在（迁移前的老文章）再读旧键
  const fromFile = await readArticleFile(id)
  if (fromFile) return fromFile
  return readLegacyArticle(id)
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
  await writeArticleFile(id, saved)
  // 迁移残留：同名旧键还在就顺手清掉（没有也不报错）
  await Preferences.remove({ key: PREFIX + id }).catch(() => {})

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
  await removeArticleFile(id)
  await Preferences.remove({ key: PREFIX + id }).catch(() => {})
  const index = await readIndex()
  await writeIndex(index.filter((a) => a.id !== id))
}

/** 文章库列表，按日期与时间倒序。顺手把还在 Preferences 里的旧文章搬进文件 */
export async function listArticles(): Promise<ArticleMeta[]> {
  void sweepLegacyArticles()
  return readIndex()
}

/** 全部文章的完整内容（备份导出用）。逐篇读，条数在千级以内没有性能问题 */
export async function listFullArticles(): Promise<Article[]> {
  const index = await readIndex()
  const out: Article[] = []
  for (const meta of index) {
    const a = await getArticleById(meta.id)
    if (a) out.push(a)
  }
  return out
}

/**
 * 清空全部生成文章（含索引）。**文章不可再生**，调用方必须先过用户两次确认。
 * 备份导出（0.24.22 起）含文章——清空前建议先导出一份。
 */
export async function clearArticles(): Promise<number> {
  const index = await readIndex()
  await Promise.all(index.map((a) => removeArticleFile(a.id)))
  // 迁移残留的旧键一并清
  const { keys } = await Preferences.keys()
  const legacyKeys = keys.filter((k) => k.startsWith(PREFIX))
  await Promise.all(legacyKeys.map((k) => Preferences.remove({ key: k }).catch(() => {})))
  await writeIndex([])
  return index.length
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
