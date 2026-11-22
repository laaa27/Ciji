import { Preferences } from '@capacitor/preferences'

import type { Article } from '@/domain/article/model'
import { listFileNames, queueByKey, readJson, removeFile, writeJson } from '@/data/files'
import {
  createOnceTask,
  isMigrated,
  legacyKeys,
  markMigrated,
  removeLegacyKeys,
} from '@/data/migrate'
import { countWordsIn } from '@/lib/text'

/**
 * 文章存储。每次生成都留档，不覆盖。
 *
 * 三处：
 * - `articles/<id>.json`   全文，id 形如 2026-11-07#2
 * - `articles/index.json`  元信息列表（日期 / 标题 / 词数），列表页只读它
 * - `article:<id>` / `article_index`  旧键，只剩「迁移没跑完时」的读取兜底
 *
 * 为什么要索引：单篇约 5.5KB，一千篇就是 5MB，
 * 每次列表都把全文读出来解析会卡好几秒。索引只有二百多字节一条。
 *
 * 索引为什么也搬进文件（0.24.27）：它是 Preferences 里最后一块**会长大**的数据
 * （每篇 +240 B，40 篇就 9.7 KB，占整个 XML 的 81%）。搬走之后 XML 只剩偏好与凭证，
 * 且只在改设置时才重写。索引是可再生产物——目录扫一遍就能重建，所以迁移不用留副本。
 */

const PREFIX = 'article:'
const DIR = 'articles'
const INDEX_FILE = 'articles/index.json'
const LEGACY_INDEX_KEY = 'article_index'

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

function metaOf(id: string, a: Article): ArticleMeta {
  return {
    id,
    date: a.date,
    title: a.title,
    wordCount: countWordsIn(a.sentences),
    createdAt: a.createdAt,
  }
}

function isMeta(x: unknown): x is ArticleMeta {
  const m = x as ArticleMeta | null
  return Boolean(m) && typeof m?.id === 'string' && typeof m?.date === 'string'
}

async function writeIndexFile(list: ArticleMeta[]): Promise<void> {
  await writeJson(INDEX_FILE, list)
}

async function readIndexFile(): Promise<ArticleMeta[] | null> {
  const raw = await readJson<unknown>(INDEX_FILE)
  return Array.isArray(raw) ? raw.filter(isMeta) : null
}

/** 旧键里的索引（迁移没跑完 / 上次中断） */
async function readLegacyIndex(): Promise<ArticleMeta[] | null> {
  const { value } = await Preferences.get({ key: LEGACY_INDEX_KEY })
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter(isMeta) : null
  } catch {
    return null
  }
}

/**
 * 读索引：文件优先，其次旧键，两边都没有就重建一次。
 *
 * 重建从 `articles/` 目录（外加迁移前还留在 Preferences 的旧全文键）扫一遍，
 * 所以索引丢了不是数据丢失，最多慢一次。
 */
async function readIndex(): Promise<ArticleMeta[]> {
  const fromFile = await readIndexFile()
  if (fromFile) return fromFile

  const legacy = await readLegacyIndex()
  if (legacy) return legacy

  const rebuilt = await rebuildIndex()
  if (rebuilt.length > 0) await writeIndexFile(rebuilt)
  return rebuilt
}

async function rebuildIndex(): Promise<ArticleMeta[]> {
  const ids = new Set(
    (await listFileNames(DIR))
      .filter((n) => n.endsWith('.json') && n !== 'index.json')
      .map((n) => n.slice(0, -'.json'.length)),
  )
  const { keys } = await Preferences.keys()
  for (const k of keys) if (k.startsWith(PREFIX)) ids.add(k.slice(PREFIX.length))

  const list: ArticleMeta[] = []
  for (const id of ids) {
    const a = await getArticleById(id)
    if (a) list.push(metaOf(id, a))
  }
  return sortMetas(list)
}

/** 索引的「读-改-写」走同一个队列：同时保存两篇时不会互相覆盖 */
function mutateIndex(fn: (list: ArticleMeta[]) => ArticleMeta[]): Promise<void> {
  return queueByKey(INDEX_FILE, async () => {
    const cur = await readIndex()
    await writeIndexFile(fn(cur))
  })
}

/**
 * 一次性迁移：`article_index` → `articles/index.json`。
 *
 * 写文件并读回校验（条数不少于旧键）才删旧键；失败就留着，下次启动重试。
 * 索引是派生数据：真出问题也能从 `articles/` 目录重建，所以不需要额外留原件副本。
 */
const runEnsureArticleIndex = createOnceTask(async () => {
  const legacy = await readLegacyIndex()
  if (!legacy) return

  const fromFile = await readIndexFile()
  if (!fromFile) await writeIndexFile(legacy)

  const back = await readIndexFile()
  const expect = fromFile?.length ?? legacy.length
  if (!back || back.length < expect) throw new Error('文章索引迁移校验失败')

  await removeLegacyKeys([LEGACY_INDEX_KEY])
})

export function ensureArticleIndex(): Promise<void> {
  return runEnsureArticleIndex()
}

/* ── 文章正文的独立文件存储（0.24.22）──────────────────
 *
 * 为什么搬：所有 Preferences 键共用一个 XML、每次写全量重写——文章是其中
 * 最大的一块（5.5KB/篇），留在里面会让全文件的读写成本跟着文章数涨。
 * 每篇一个 JSON 文件（Directory.Data 下 articles/ 子目录）之后，
 * 写一篇只写一个小文件，与释义、每日记录所在的存储彻底分家。
 *
 * Filesystem 的 web 实现走 IndexedDB，两端语义一致，不需要平台分支。
 * 索引一开始留在 Preferences（「它很小」），到 0.24.27 发现它已经涨到 9.7 KB、
 * 占整个 XML 的 81%，所以也搬进了 `articles/index.json`。
 */

const ART_SUBDIR = 'articles'

function articlePath(id: string): string {
  return `${ART_SUBDIR}/${id}.json`
}

async function writeArticleFile(id: string, article: Article): Promise<void> {
  await writeJson(articlePath(id), article)
}

async function readArticleFile(id: string): Promise<Article | null> {
  const parsed = await readJson<Article>(articlePath(id))
  // id 对不上说明文件串了（历史上有过按日期覆盖的写入），当作没读到
  return parsed?.id === id ? parsed : null
}

async function removeArticleFile(id: string): Promise<void> {
  await removeFile(articlePath(id))
}

/**
 * 一次性迁移：把还留在 Preferences 里的旧文章正文搬到 `articles/<id>.json`。
 *
 * **必须在启动时跑，不能等文章库被打开**（0.24.28 改）：从 0.24.22 之前升上来的用户，
 * 全文（约 5.5 KB/篇）都还在共用 XML 里；只要不点文章库，这些数据就永远留在那儿，
 * 每次改设置都要跟着整份重写一遍。
 *
 * 每篇写完读回来核对一次（id 对得上），确认进文件了才删旧键；写不进去就留着，
 * 下个会话重试。全部清完才打标记，有残留就下次继续——部分迁移是安全状态：
 * 读取一律文件优先、旧键兜底。
 */
const K_ARTICLES_MIGRATED = 'articles_migrated'

const runEnsureArticleFiles = createOnceTask(async () => {
  if (await isMigrated(K_ARTICLES_MIGRATED)) return

  let leftover = false

  for (const key of await legacyKeys([PREFIX])) {
    const id = key.slice(PREFIX.length)
    if (!(await readArticleFile(id))) {
      const legacy = await readLegacyArticle(id)
      if (legacy) {
        await writeArticleFile(id, legacy)
        if (!(await readArticleFile(id))) {
          // 没写进去：旧键留着，下次启动再试
          leftover = true
          continue
        }
      }
    }
    // 走到这里说明文件里已经有这篇了（本次搬的，或上次中断留下的），旧键可以清
    await removeLegacyKeys([key], () => {
      leftover = true
    })
  }

  if (!leftover) await markMigrated(K_ARTICLES_MIGRATED)
})

export function ensureArticleFiles(): Promise<void> {
  return runEnsureArticleFiles()
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

  const meta = metaOf(id, saved)
  await mutateIndex((list) => sortMetas([meta, ...list.filter((a) => a.id !== id)]))

  return saved
}

export async function deleteArticle(id: string): Promise<void> {
  await removeArticleFile(id)
  await Preferences.remove({ key: PREFIX + id }).catch(() => {})
  await mutateIndex((list) => list.filter((a) => a.id !== id))
}

/** 文章库列表，按日期与时间倒序。顺手推一把旧文章与索引的迁移（启动时已跑过一次） */
export async function listArticles(): Promise<ArticleMeta[]> {
  void ensureArticleFiles()
  void ensureArticleIndex()
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
  await removeLegacyKeys(await legacyKeys([PREFIX]))
  await writeIndexFile([])
  await removeLegacyKeys([LEGACY_INDEX_KEY])
  return index.length
}

/**
 * 某天的所有文章（按索引顺序）。只读，不含迁移副作用。
 *
 * 「哪些词算当天已用」是业务口径，住在 `domain/article/usage.ts`；
 * 这里只负责把这一天的正文取出来。
 */
export async function articlesOfDay(date: string): Promise<Article[]> {
  const index = await readIndex()
  const out: Article[] = []
  for (const meta of index.filter((a) => a.date === date)) {
    const a = await getArticleById(meta.id)
    if (a) out.push(a)
  }
  return out
}

/** 某天最后一篇，用于打开阅读页时默认展示 */
export async function getLatestArticleOfDay(date: string): Promise<Article | null> {
  const index = await readIndex()
  const sameDay = index.filter((a) => a.date === date)
  if (sameDay.length === 0) return null
  return getArticleById(sameDay[0].id)
}
