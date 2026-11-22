import type { StudyResponse } from '@/api/types'
import type { Article } from '@/domain/article'
import type { CollectedWord, TodaySnapshot, WordState } from '@/domain/collect'

/**
 * 学习数据的「导入 / 备份」业务层。
 *
 * 只认一种格式：**备份 JSON**（本文件定义）。0.24.30 起移除了 CSV ——
 * 那条路只有日期 / 单词 / 类型，缺学习时长与逐词反馈，导入时还得给用户一堆
 * 「补不回来」的提示；与其维护一条半残通道，不如把无损备份做扎实。
 *
 * 这一层全是纯函数：解析、校验、合并计划。写盘由各 `data/` 模块负责。
 */

export const BACKUP_FORMAT = 'ciji-backup'
/** v2：加入 `articles`（生成的文章全文）。v1 备份没有该字段，导入时当空处理 */
export const BACKUP_VERSION = 2

export interface BackupFile {
  format: string
  version: number
  app: string
  exportedAt: string
  count: number
  days: TodaySnapshot[]
  /** v2 起携带：生成的文章全文。文章不可再生，备份必须带走 */
  articles?: Article[]
}

export function buildBackup(days: TodaySnapshot[], articles: Article[] = []): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: '词迹',
    exportedAt: new Date().toISOString(),
    count: days.length,
    days,
    ...(articles.length > 0 ? { articles } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* 校验与规范化                                                        */
/* ------------------------------------------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const STATE_LABEL: Record<string, WordState> = {
  新学: 'new',
  模糊: 'vague',
  忘记: 'forget',
  new: 'new',
  vague: 'vague',
  forget: 'forget',
}

const RESPONSES: StudyResponse[] = [
  'FAMILIAR',
  'VAGUE',
  'FORGET',
  'WELL_FAMILIAR',
  'CANCEL_WELL_FAMILIAR',
]

function isWordState(v: unknown): v is WordState {
  return v === 'new' || v === 'vague' || v === 'forget'
}

function isResponse(v: unknown): v is StudyResponse {
  return typeof v === 'string' && (RESPONSES as string[]).includes(v)
}

/** 日期必须是合法且真实存在的 YYYY-MM-DD（挡掉 2026-13-45 这种） */
function normalizeDate(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!DATE_RE.test(s)) return null
  return Number.isNaN(Date.parse(`${s}T00:00:00+08:00`)) ? null : s
}

/** 「新学/模糊」「new+vague」都认 */
function groupsFromKind(kind: string): WordState[] {
  const out: WordState[] = []
  for (const part of kind.split(/[/、,，|+\s]+/)) {
    const s = STATE_LABEL[part.trim().toLowerCase()] ?? STATE_LABEL[part.trim()]
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

function responseFromGroups(groups: WordState[]): StudyResponse {
  if (groups.includes('forget')) return 'FORGET'
  if (groups.includes('vague')) return 'VAGUE'
  return 'FAMILIAR'
}

function toInt(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback
}

/**
 * 单个词条规范化。返回 null 表示这条不该进库。
 *
 * 分组为空的词会被丢弃：那正是「只复习、答了认识」的词，
 * 实时采集时同样不会入库。留着会让统计里的「新学」凭空变大。
 */
function normalizeWord(raw: unknown, order: number): CollectedWord | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>

  const spelling = String(w.spelling ?? w.word ?? '').trim()
  if (!spelling) return null

  let groups: WordState[] = []
  if (Array.isArray(w.groups)) {
    groups = w.groups.filter(isWordState)
  }
  if (groups.length === 0 && isWordState(w.state)) groups = [w.state]
  if (groups.length === 0 && typeof w.kind === 'string') groups = groupsFromKind(w.kind)
  if (groups.length === 0 && w.isNew === true) groups = ['new']
  if (groups.length === 0) return null

  const vocId = String(w.vocId ?? '').trim() || `imp:${spelling.toLowerCase()}`

  return {
    vocId,
    spelling,
    groups,
    isNew: Boolean(w.isNew) || groups.includes('new'),
    // 缺失时按分组反推，保证竖线颜色与统计口径一致
    firstResponse: isResponse(w.firstResponse) ? w.firstResponse : responseFromGroups(groups),
    lastResponse: isResponse(w.lastResponse) ? w.lastResponse : undefined,
    isFinished: w.isFinished === undefined ? true : Boolean(w.isFinished),
    order: Number.isFinite(Number(w.order)) ? Number(w.order) : order,
  }
}

/** 一天快照规范化；词全被过滤掉时返回 null */
function normalizeSnapshot(raw: unknown): TodaySnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const date = normalizeDate(r.date)
  if (!date) return null

  const rawWords = Array.isArray(r.words) ? r.words : []
  const words: CollectedWord[] = []
  for (const item of rawWords) {
    const word = normalizeWord(item, words.length)
    if (word) words.push(word)
  }
  if (words.length === 0) return null

  // order 兜底后统一排序，恢复后的顺序与原来一致
  words.sort((a, b) => a.order - b.order)

  return {
    date,
    finished: toInt(r.finished, words.length),
    total: toInt(r.total, words.length),
    studyTimeMs: toInt(r.studyTimeMs, 0),
    words,
    collectedAt: typeof r.collectedAt === 'string' ? r.collectedAt : new Date().toISOString(),
    warning: typeof r.warning === 'string' ? r.warning : undefined,
    rawCount: toInt(r.rawCount, words.length),
    studiedCount: toInt(r.studiedCount, words.length),
  }
}


/* ------------------------------------------------------------------ */
/* 对外：解析文件                                                      */
/* ------------------------------------------------------------------ */

export interface ImportPreview {
  /** 按日期升序，重复日期已合并 */
  days: TodaySnapshot[]
  /** v2 起携带的生成文章 */
  articles: Article[]
  /** 被丢弃的行数 / 条目数 */
  skipped: number
  /** 需要让用户知道的情况，不阻断导入 */
  notes: string[]
}

/**
 * 文章条目规范化。只做结构校验（id / 标题 / 正文存在），其余字段原样保留——
 * 文章是不可再生的用户数据，宁可全盘带回来，也不能因为某个可选字段不对就丢弃。
 */
function normalizeArticle(raw: unknown): Article | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const id = typeof a.id === 'string' && a.id.trim() ? a.id : null
  const title = typeof a.title === 'string' && a.title.trim() ? a.title : null
  const sentences = Array.isArray(a.sentences)
    ? a.sentences.filter(
        (s) => s && typeof s === 'object' && typeof (s as { en?: unknown }).en === 'string',
      )
    : []
  if (!id || !title || sentences.length === 0) return null
  return a as unknown as Article
}

function importJson(text: string): {
  days: TodaySnapshot[]
  articles: Article[]
  skipped: number
  notes: string[]
} {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('文件不是合法的备份 JSON')
  }

  const notes: string[] = []
  let rawDays: unknown[] = []
  let rawArticles: unknown[] = []

  if (Array.isArray(data)) {
    rawDays = data
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.days)) {
      rawDays = obj.days
      const version = Number(obj.version)
      if (obj.format !== undefined && obj.format !== BACKUP_FORMAT) {
        throw new Error('这不是词迹的备份文件')
      }
      if (Number.isFinite(version) && version > BACKUP_VERSION) {
        notes.push(`备份来自更新版本（v${version}），部分字段可能读不到`)
      }
      if (Array.isArray(obj.articles)) {
        rawArticles = obj.articles
      } else if (Number.isFinite(Number(obj.version)) && Number(obj.version) < 2) {
        notes.push('这份备份早于文章纳入备份（v2），不含生成文章')
      }
    } else if ('date' in obj || 'words' in obj) {
      // 单日快照，或者用户手工拼的单天对象
      rawDays = [obj]
    }
  }

  const articles: Article[] = []
  let artSkipped = 0
  for (const item of rawArticles) {
    const art = normalizeArticle(item)
    if (art) articles.push(art)
    else artSkipped += 1
  }
  if (artSkipped > 0) notes.push(`${artSkipped} 篇文章数据不完整，已跳过`)

  if (rawDays.length === 0 && articles.length === 0) {
    throw new Error('文件里没有可导入的学习记录')
  }

  const byDate = new Map<string, TodaySnapshot>()
  let skipped = 0
  let dup = 0

  for (const item of rawDays) {
    const snap = normalizeSnapshot(item)
    if (!snap) {
      skipped += 1
      continue
    }
    if (byDate.has(snap.date)) dup += 1
    // 同一天多条：保留词更多的那个，不让后出现的空壳覆盖完整数据
    const prev = byDate.get(snap.date)
    if (!prev || snap.words.length >= prev.words.length) byDate.set(snap.date, snap)
  }

  if (skipped > 0) notes.push(`${skipped} 天的数据无法识别，已跳过`)
  if (dup > 0) notes.push(`${dup} 天重复出现，已取词数最多的一条`)

  return {
    days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    articles,
    skipped,
    notes,
  }
}

/**
 * 解析备份内容。扩展名不作数（用户可能把 .json 存成 .txt），只看内容：
 * 对象或数组都当 JSON，其余一律拒绝。
 */
export function parseImportText(text: string): ImportPreview {
  const body = text.replace(/^\uFEFF/, '').trimStart()
  if (body === '') throw new Error('文件是空的')
  if (!body.startsWith('{') && !body.startsWith('[')) {
    throw new Error('无法识别的文件，请选择「导出备份」生成的 JSON')
  }

  const res = importJson(body)
  return { days: res.days, articles: res.articles, skipped: res.skipped, notes: res.notes }
}

/* ------------------------------------------------------------------ */
/* 对外：合并计划                                                      */
/* ------------------------------------------------------------------ */

export type ImportMode = 'fill' | 'overwrite'

export interface ImportPlan {
  mode: ImportMode
  /** 真正要写入的日子 */
  write: TodaySnapshot[]
  added: number
  replaced: number
  kept: number
}

/**
 * fill      = 只补本地没有的日期，绝不覆盖已有记录
 * overwrite = 同日期以文件为准（新日期同样写入）
 */
export function planImport(
  days: TodaySnapshot[],
  existing: Iterable<string>,
  mode: ImportMode,
): ImportPlan {
  const have = new Set(existing)
  const write: TodaySnapshot[] = []
  let added = 0
  let replaced = 0
  let kept = 0

  for (const day of days) {
    const conflict = have.has(day.date)
    if (conflict && mode === 'fill') {
      kept += 1
      continue
    }
    write.push(day)
    if (conflict) replaced += 1
    else added += 1
  }

  return { mode, write, added, replaced, kept }
}

export interface ImportSummary {
  count: number
  words: number
  first: string
  last: string
}

export function summarize(days: TodaySnapshot[]): ImportSummary {
  let words = 0
  for (const d of days) words += d.words.length
  const dates = days.map((d) => d.date).sort()
  return {
    count: days.length,
    words,
    first: dates[0] ?? '',
    last: dates[dates.length - 1] ?? '',
  }
}
