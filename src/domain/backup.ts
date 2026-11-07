import type { StudyResponse } from '@/api/types'
import type { CollectedWord, TodaySnapshot, WordState } from '@/domain/collect'

/**
 * 学习数据的「导入 / 备份」业务层。
 *
 * 两种可导入的格式：
 * - **备份 JSON**（本文件定义，全保真）：包含每天完整的快照，恢复后与导出前一致
 * - **CSV**（与「导出 CSV」同构，有损）：只有 日期 / 单词 / 类型 / 释义，
 *   缺学习时长与逐词反馈，导入时给出提示而不是假装完整
 *
 * 这一层全是纯函数：解析、校验、合并计划。写盘由 data/store.ts 负责。
 */

export const BACKUP_FORMAT = 'ciji-backup'
export const BACKUP_VERSION = 1

export interface BackupFile {
  format: string
  version: number
  app: string
  exportedAt: string
  count: number
  days: TodaySnapshot[]
}

export function buildBackup(days: TodaySnapshot[]): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: '词迹',
    exportedAt: new Date().toISOString(),
    count: days.length,
    days,
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
/* CSV 解析                                                            */
/* ------------------------------------------------------------------ */

/** 标准 CSV 状态机：支持引号、字段内的逗号与换行、"" 转义 */
function splitCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += ch
      }
      continue
    }

    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') {
      cell += ch
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

const DATE_HEADERS = ['日期', 'date', 'day']
const WORD_HEADERS = ['单词', 'word', 'spelling']
const KIND_HEADERS = ['类型', '分组', 'kind', 'group', 'state', 'groups']

function findColumn(header: string[], candidates: string[]): number {
  return header.findIndex((h) => candidates.includes(h.trim().toLowerCase()))
}

/** 从 CSV 文本还原成天快照；导出时的表头顺序与列名都能认 */
function importCsv(text: string): { days: TodaySnapshot[]; skipped: number } {
  const rows = splitCsv(text.replace(/^\uFEFF/, ''))
  if (rows.length === 0) return { days: [], skipped: 0 }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  let dateCol = findColumn(header, DATE_HEADERS)
  let wordCol = findColumn(header, WORD_HEADERS)
  let kindCol = findColumn(header, KIND_HEADERS)

  // 没表头就按导出顺序（日期,单词,类型,释义）硬解析，并当成全量数据
  const hasHeader = dateCol >= 0 || wordCol >= 0
  const body = hasHeader ? rows.slice(1) : rows
  if (!hasHeader) {
    dateCol = 0
    wordCol = 1
    kindCol = 2
  }
  if (dateCol < 0 || wordCol < 0) {
    throw new Error('CSV 缺少「日期」或「单词」列，无法识别')
  }

  const byDate = new Map<string, Map<string, CollectedWord>>()
  let skipped = 0

  for (const row of body) {
    const date = normalizeDate(row[dateCol])
    const spelling = (row[wordCol] ?? '').trim()
    if (!date || !spelling) {
      skipped += 1
      continue
    }

    const kind = kindCol >= 0 ? (row[kindCol] ?? '') : ''
    const groups = kind ? groupsFromKind(kind) : (['new'] as WordState[])

    const bucket = byDate.get(date) ?? new Map<string, CollectedWord>()
    const key = spelling.toLowerCase()
    const exist = bucket.get(key)

    if (exist) {
      // 同一单词在同一天出现多次：合并分组
      for (const g of groups) if (!exist.groups.includes(g)) exist.groups.push(g)
      exist.isNew = exist.isNew || exist.groups.includes('new')
      exist.firstResponse = responseFromGroups(exist.groups)
    } else {
      bucket.set(key, {
        vocId: `imp:${key}`,
        spelling,
        groups: [...groups],
        isNew: groups.includes('new'),
        firstResponse: responseFromGroups(groups),
        isFinished: true,
        order: bucket.size,
      })
    }
    byDate.set(date, bucket)
  }

  const days: TodaySnapshot[] = []
  for (const [date, bucket] of byDate) {
    const words = [...bucket.values()]
    days.push({
      date,
      // CSV 里没有进度总量，把已知学过的词数当分母，避免界面出现 12/—
      finished: words.length,
      total: words.length,
      studyTimeMs: 0,
      words,
      collectedAt: new Date().toISOString(),
      warning: '这天由 CSV 导入：只有单词与分组，学习时长和逐词反馈无法还原',
      rawCount: words.length,
      studiedCount: words.length,
    })
  }

  return { days, skipped }
}

/* ------------------------------------------------------------------ */
/* 对外：解析文件                                                      */
/* ------------------------------------------------------------------ */

export type ImportSource = 'json' | 'csv'

export interface ImportPreview {
  source: ImportSource
  /** 按日期升序，重复日期已合并 */
  days: TodaySnapshot[]
  /** 被丢弃的行数 / 条目数 */
  skipped: number
  /** 需要让用户知道的情况，不阻断导入 */
  notes: string[]
}

function importJson(text: string): { days: TodaySnapshot[]; skipped: number; notes: string[] } {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('文件不是合法 JSON，也不是能识别的 CSV')
  }

  const notes: string[] = []
  let rawDays: unknown[] = []

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
    } else if ('date' in obj || 'words' in obj) {
      // 单日快照，或者用户手工拼的单天对象
      rawDays = [obj]
    }
  }

  if (rawDays.length === 0) {
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
    skipped,
    notes,
  }
}

/** 按内容嗅探格式，扩展名只作参考（用户可能把 .csv 存成 .txt） */
export function parseImportText(filename: string, text: string): ImportPreview {
  const body = text.replace(/^\uFEFF/, '').trimStart()
  if (body === '') throw new Error('文件是空的')

  const looksJson = body.startsWith('{') || body.startsWith('[')
  const looksCsv = /\.csv$/i.test(filename) || body.startsWith('日期') || body.includes(',\n')

  if (looksJson) {
    const res = importJson(body)
    return { source: 'json', ...res }
  }
  if (looksCsv) {
    const res = importCsv(body)
    if (res.days.length === 0) throw new Error('CSV 里没有可导入的行')
    return {
      source: 'csv',
      days: res.days,
      skipped: res.skipped,
      notes: res.skipped > 0 ? [`${res.skipped} 行格式不对，已跳过`] : [],
    }
  }

  throw new Error('无法识别的文件格式，请选择词迹导出的 CSV 或备份 JSON')
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
