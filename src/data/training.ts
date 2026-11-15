import type { TrainingIndexItem, TrainingPaper } from '@/domain/training'

/**
 * 训练题库的读取。
 *
 * 数据是构建时打进 App 的静态 JSON（`public/training/`），不是用户数据，
 * 所以不进 Preferences：走 fetch + 内存缓存即可，进程重启自然重新读。
 *
 * 为什么按套分文件：全量一百多套一个文件要几 MB，而列表页只需要几十字节一条的索引。
 * 与 `data/article.ts` 的「全文 + 索引」同构。
 */

const BASE = `${import.meta.env.BASE_URL}training`

let indexCache: TrainingIndexItem[] | null = null
/** 已经读过的套卷。做题时来回翻不会再请求一次 */
const paperCache = new Map<string, TrainingPaper>()

async function readJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  // 404 基本只有一个原因：构建时没跑导入脚本，题库没进包。说清楚，别让人以为是网络问题
  if (res.status === 404) throw new Error('训练题库还没有导入')
  if (!res.ok) throw new Error(`题库读取失败（${res.status}）`)
  return (await res.json()) as T
}

export async function loadTrainingIndex(): Promise<TrainingIndexItem[]> {
  if (indexCache) return indexCache
  const data = await readJson<{ papers: TrainingIndexItem[] }>(`${BASE}/index.json`)
  indexCache = data.papers
  return indexCache
}

export async function loadTrainingPaper(key: string): Promise<TrainingPaper> {
  const hit = paperCache.get(key)
  if (hit) return hit
  const paper = await readJson<TrainingPaper>(`${BASE}/p/${key}.json`)
  paperCache.set(key, paper)
  return paper
}
