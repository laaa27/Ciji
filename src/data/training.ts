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

/* ── 每篇的最近一次成绩（localStorage，同步落盘） ────────────── */

/**
 * 为什么是 localStorage 而不是 Preferences：成绩在「点提交」的瞬间写入，
 * App 必在前台，同步写完才返回，进程随后被杀也不会丢。
 * 做题进度持久化两次失败的正是「进程被杀时异步写入还没落盘」——
 * 成绩的写入时机天然不存在这个窗口，所以敢用同步存储。
 */
const SCORE_PREFIX = 'cjt.score.'

export type TrainScore = {
  right: number
  total: number
  /** 提交时刻（ISO） */
  at: string
  /** 本次做题用时（秒）。早期数据没有这个字段 */
  secs?: number
}

/** 成绩键：套卷 key + 篇目 id。篇目 id 只在套卷内唯一（cloze-1 每套卷都有），
    裸用会跨卷串成绩——0.24.13 及以前的 bug 正是这么来的 */
export function scoreKey(paperKey: string, passageId: string): string {
  return `${paperKey}#${passageId}`
}

/** 0.24.13 及以前落盘的成绩键裸用篇目 id，全是串了卷的脏数据；进训练页时清一次 */
export function sweepLegacyScores(): void {
  try {
    const stale: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(SCORE_PREFIX) && !k.includes('#')) stale.push(k)
    }
    for (const k of stale) window.localStorage.removeItem(k)
  } catch {
    // localStorage 不可用就没有可清的
  }
}

/** 把一段 JSON 解析成成绩；结构不对当没有。读路径与备份导出共用这一处判定 */
function parseScore(raw: string | null): TrainScore | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as TrainScore
    if (typeof s.right !== 'number' || typeof s.total !== 'number' || !s.at) return null
    return s
  } catch {
    return null
  }
}

export function readScore(paperKey: string, passageId: string): TrainScore | null {
  try {
    return parseScore(
      window.localStorage.getItem(SCORE_PREFIX + scoreKey(paperKey, passageId)),
    )
  } catch {
    return null
  }
}

export function saveScore(paperKey: string, passageId: string, score: TrainScore): void {
  try {
    window.localStorage.setItem(
      SCORE_PREFIX + scoreKey(paperKey, passageId),
      JSON.stringify(score),
    )
  } catch {
    // 配额满 / 隐私模式：成绩丢了不影响做题，不打扰用户
  }
}

/**
 * 全部成绩（备份用）：键是去掉前缀的 `套卷key#篇目id`。
 * localStorage 不可用（隐私模式 / 配额异常）时返回空表 —— 导出侧要据此提示
 * 「本设备没有可导出的成绩」，而不是假装成功导出了 0 条。
 */
export function listScores(): Record<string, TrainScore> {
  const out: Record<string, TrainScore> = {}
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i)
      if (!k || !k.startsWith(SCORE_PREFIX)) continue
      const key = k.slice(SCORE_PREFIX.length)
      const score = parseScore(window.localStorage.getItem(k))
      if (score) out[key] = score
    }
  } catch {
    return {}
  }
  return out
}

/**
 * 导入用：按完整键直接写入。
 * 只接受带 `#` 的键（与 `sweepLegacyScores` 同一条判据），否则会把串号脏键又写回去。
 */
export function writeScoreEntry(key: string, score: TrainScore): void {
  const k = key.trim()
  if (!k.includes('#')) return
  try {
    window.localStorage.setItem(SCORE_PREFIX + k, JSON.stringify(score))
  } catch {
    // 同 saveScore：写不进去不影响做题
  }
}
