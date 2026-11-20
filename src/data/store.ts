import { Preferences } from '@capacitor/preferences'

import type { TodaySnapshot } from '@/domain/collect'
import {
  clearDaySnapshot,
  ensureDayFiles,
  legacyDayDates,
  listDayDates,
  listSnapshotDates,
  readDayFile,
  readLegacySnapshot,
  removeDayFile,
  removeLegacyDayKeys,
  writeDaySnapshot,
} from '@/data/dayFile'

/**
 * 数据层：按天存一份学习快照。
 *
 * 存储（0.24.26 起）：`Directory.Data/days/YYYY-MM-DD.json`，一天一个文件。
 * 为什么从 Preferences 搬出来：所有键共用一个 XML、每次写全量重写，而 `day:` 曾占
 * 那个文件的 92%（每天 23 KB、永不淘汰），阅读计时每 15 秒落盘一次就把它整份重写一遍。
 * 文件格式与迁移规则见 `data/dayFile.ts`。
 *
 * `day_index`（已记录日期的升序列表）仍留在 Preferences：323 B / 14 天，读它就不用
 * 扫整个目录。老安装没有这个键时，第一次 `listDays()` 从文件目录 + 旧键重建一次。
 */
const K_DAY_INDEX = 'day_index'

type LegacyWord = Record<string, unknown> & {
  state?: 'new' | 'vague' | 'forget'
  groups?: ('new' | 'vague' | 'forget')[]
}

/**
 * 兼容早期版本写入的数据：
 * 那时每词只有一个 `state` 字段，且没有 rawCount / studiedCount。
 * 不做迁移的话，升级后读旧记录会崩。
 */
function normalize(raw: Record<string, unknown>): TodaySnapshot {
  const rawWords = Array.isArray(raw.words) ? (raw.words as LegacyWord[]) : []

  const words: TodaySnapshot['words'] = rawWords.map((w) => {
    let groups = w.groups
    if (!groups) {
      if (w.state) groups = [w.state]
      else if (w.isNew) groups = ['new']
      else groups = []
    }

    return {
      vocId: String(w.vocId ?? ''),
      spelling: String(w.spelling ?? ''),
      groups,
      isNew: Boolean(w.isNew),
      firstResponse: w.firstResponse as TodaySnapshot['words'][number]['firstResponse'],
      lastResponse: w.lastResponse as TodaySnapshot['words'][number]['lastResponse'],
      isFinished: Boolean(w.isFinished),
      order: Number(w.order ?? 0),
    }
  })

  return {
    date: String(raw.date ?? ''),
    finished: Number(raw.finished ?? 0),
    total: Number(raw.total ?? 0),
    studyTimeMs: Number(raw.studyTimeMs ?? 0),
    words,
    collectedAt: String(raw.collectedAt ?? new Date().toISOString()),
    warning: raw.warning as string | undefined,
    rawCount: Number(raw.rawCount ?? words.length),
    studiedCount: Number(raw.studiedCount ?? words.length),
  }
}

/** 写入某天快照；同一天重复写入直接覆盖（天然幂等），当天的阅读秒数保留 */
export async function saveDay(snapshot: TodaySnapshot): Promise<void> {
  await writeDaySnapshot(snapshot.date, snapshot)
  await indexAdd(snapshot.date)
}

/**
 * 批量写入（导入用）。语义与采集一致：同日期直接覆盖。
 * 串行写入，避免一次打太多文件请求。
 */
export async function writeDays(snapshots: TodaySnapshot[]): Promise<void> {
  for (const snap of snapshots) {
    await saveDay(snap)
  }
}

export async function getDay(date: string): Promise<TodaySnapshot | null> {
  const file = await readDayFile(date)
  if (file?.snapshot) return normalize(file.snapshot as unknown as Record<string, unknown>)

  // 迁移还没轮到这一天（或迁移中断）：旧键里还有数据
  const legacy = await readLegacySnapshot(date)
  return legacy ? normalize(legacy) : null
}

/** 所有已记录的日期，按倒序（最新在前） */
export async function listDays(): Promise<string[]> {
  // 顺手推一把迁移，不阻塞列表（列表读的是索引，与文件无关）
  void ensureDayFiles()

  const index = await readDayIndex()
  if (index) return [...index].reverse()

  // 没有索引（老安装 / 索引损坏）：从文件目录与旧键各扫一遍，重建后增量维护
  const dates = [...new Set([...(await listSnapshotDates()), ...(await legacyDayDates())])].sort()
  await writeDayIndex(dates)
  return [...dates].reverse()
}

async function readDayIndex(): Promise<string[] | null> {
  const { value } = await Preferences.get({ key: K_DAY_INDEX })
  if (!value) return null
  try {
    const list = JSON.parse(value) as unknown
    if (!Array.isArray(list) || !list.every((d) => typeof d === 'string')) return null
    return list as string[]
  } catch {
    return null
  }
}

async function writeDayIndex(dates: string[]): Promise<void> {
  await Preferences.set({ key: K_DAY_INDEX, value: JSON.stringify(dates) }).catch(() => {})
}

async function indexAdd(date: string): Promise<void> {
  const index = (await readDayIndex()) ?? []
  if (index.includes(date)) return
  await writeDayIndex([...index, date].sort())
}

/** 读取全部历史快照，最新在前 */
export async function getAllDays(): Promise<TodaySnapshot[]> {
  const days = await listDays()
  const out: TodaySnapshot[] = []
  for (const d of days) {
    const snap = await getDay(d)
    if (snap) out.push(snap)
  }
  return out
}

/**
 * 删除某天的学习记录。当天的阅读秒数存在同一个文件里，不属于「学习记录」，保留。
 */
export async function deleteDay(date: string): Promise<void> {
  await clearDaySnapshot(date)
  await Preferences.remove({ key: `day:${date}` }).catch(() => {})
  const index = await readDayIndex()
  if (index) await writeDayIndex(index.filter((d) => d !== date))
}

/**
 * 清空全部历史（含阅读时长）。
 *
 * 0.24.26 起阅读秒数与快照同文件，所以「清空记录」一并清掉——以前只删 `day:`，
 * 用户以为清干净了文件其实没瘦。释义缓存、文章、成绩不在此列。
 */
export async function clearAll(): Promise<void> {
  for (const date of await listDayDates()) await removeDayFile(date)
  await removeLegacyDayKeys()
  await writeDayIndex([])
}

/* ── 死键清扫（0.24.26） ──────────────────────────
 *
 * 两组键在源码里零引用，永远不会被读、也不会被任何清理逻辑碰到，
 * 就一直躺在共用 XML 里陪着每一次全量重写。每会话扫一次，清掉完事。
 */
const DEAD_PREFIXES = ['training_progress:', 'predictive_back']

let deadSwept = false

export async function sweepDeadKeys(): Promise<void> {
  if (deadSwept) return
  deadSwept = true
  try {
    const { keys } = await Preferences.keys()
    const dead = keys.filter((k) => DEAD_PREFIXES.some((p) => k.startsWith(p)))
    for (const key of dead) await Preferences.remove({ key }).catch(() => {})
  } catch {
    // 清不掉不影响任何功能，下个会话再试
    deadSwept = false
  }
}
