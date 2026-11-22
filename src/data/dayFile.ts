import { Preferences } from '@capacitor/preferences'

import type { TodaySnapshot } from '@/domain/collect'
import { listFileNames, queueByKey, readJson, removeFile, writeJson } from '@/data/files'
import {
  createOnceTask,
  isMigrated,
  legacyKeys,
  markMigrated,
  removeLegacyKeys,
  writeVerifiedDump,
} from '@/data/migrate'
import { sameRecord } from '@/data/migrate/dump'

/**
 * 每日记录的文件存储（0.24.26）。
 *
 * 为什么从 Preferences 搬出来：所有 Preferences 键共用一个 XML，每次写任意一个键都
 * 整份重写；而 `day:` 占了那个文件的 92%（实测 14 天 315.8 KB，每天 23 KB，永不淘汰），
 * 阅读计时每 15 秒落一次盘 ⇒ 读半小时书等于全量重写 120 次、写掉 41 MB。
 * 一天一个文件之后，写今天只写今天那 23 KB，与释义、token、偏好彻底分家。
 *
 * 文件内容（`Directory.Data/days/YYYY-MM-DD.json`）：
 * ```json
 * { "date": "2026-11-19", "readingSeconds": 1234, "snapshot": { ...TodaySnapshot } }
 * ```
 * `snapshot` 缺省 = 那天只读过书、没采集过词（历史页不该列出这种日期）；
 * `readingSeconds` 缺省 = 那天没读过书。
 *
 * 迁移（`day:` 与 `reading:` 两个旧前缀）是本模块最危险的一段，规则写死在这里：
 * 1. **先落原件**：搬迁前把要动的那批旧键原样写进 `migration/legacy-*.json`，读回校验条数与内容
 * 2. **写成功才删**：每天写完都读回校验（快照在不在、秒数够不够），不通过就抛错中断，旧键留着
 * 3. **分批**：一次启动最多 120 天，剩下的下次继续；部分迁移是安全的——读取一律文件优先、旧键兜底
 */

/** 迁移前的旧键前缀：每日快照 / 每日阅读秒数 */
const LEGACY_DAY = 'day:'
const LEGACY_READING = 'reading:'

/** 全部搬完才写这个标记；有它就不必每会话扫一遍 keys() */
const K_MIGRATED = 'days_migrated'

const SUBDIR = 'days'
const SAFETY_DIR = 'migration'

/** 一次启动最多搬多少天：700 天的老用户不该在启动时卡好几秒 */
const BATCH = 120

export type DayFile = {
  date: string
  /** 学习快照。只读过书、没采集过词的日期没有这一段 */
  snapshot?: TodaySnapshot
  /** 当天累计阅读秒数 */
  readingSeconds?: number
  /** 已并入 readingSeconds 的旧 `reading:` 值，用于迁移幂等（避免中断重跑时重复累加） */
  legacyReading?: number
}

function dayPath(date: string): string {
  return `${SUBDIR}/${date}.json`
}

export async function readDayFile(date: string): Promise<DayFile | null> {
  const raw = await readJson<Partial<DayFile>>(dayPath(date))
  if (!raw || typeof raw !== 'object') return null
  const file: DayFile = { date }
  if (raw.snapshot && typeof raw.snapshot === 'object') file.snapshot = raw.snapshot
  if (typeof raw.readingSeconds === 'number') file.readingSeconds = raw.readingSeconds
  if (typeof raw.legacyReading === 'number') file.legacyReading = raw.legacyReading
  return file
}

/**
 * 读-改-写，按日期串行。`mutate` 返回 null 表示「没有要改的」，这时连文件都不碰。
 * 必须走这里而不能各自 `readDayFile` + `writeJson`：阅读计时与采集落盘会同时改同一天。
 */
export function updateDayFile(
  date: string,
  mutate: (cur: DayFile | null) => DayFile | null,
): Promise<void> {
  return queueByKey(dayPath(date), async () => {
    const cur = await readDayFile(date)
    const next = mutate(cur)
    if (!next) return
    await writeJson(dayPath(date), next)
  })
}

/** 写某天的学习快照（覆盖；阅读秒数保留） */
export async function writeDaySnapshot(date: string, snapshot: TodaySnapshot): Promise<void> {
  await updateDayFile(date, (cur) => ({ ...(cur ?? { date }), snapshot }))
}

/** 读某天累计阅读秒数：文件优先，文件没有这一段时回落到旧键 */
export async function readDayReading(date: string): Promise<number> {
  const file = await readDayFile(date)
  if (file?.readingSeconds !== undefined) return file.readingSeconds
  const legacy = await readLegacyReading(date)
  return legacy ?? 0
}

/** 给某天累加阅读秒数。旧键还没搬进来时把它当底数，避免第一次累加冲掉旧记录 */
export async function addDayReading(date: string, sec: number): Promise<void> {
  if (sec <= 0) return
  const legacy = await readLegacyReading(date)
  await updateDayFile(date, (cur) => {
    const base = cur?.readingSeconds ?? 0
    const pending = cur?.legacyReading === undefined ? (legacy ?? 0) : 0
    const total = base + pending + Math.floor(sec)
    const next: DayFile = { ...(cur ?? { date }), readingSeconds: total }
    if (pending > 0) next.legacyReading = pending
    return next
  })
}

/**
 * 直接把某天的阅读秒数设成某个值（导入用，**绝对写**）。
 *
 * 为什么不能复用 `addDayReading`：那是「累加」，同一份备份导两次就会翻倍。
 * 导入恢复的是「那天一共读了多少」，语义上是覆盖。
 *
 * 顺带把旧键的底数记进 `legacyReading`：否则迁移还没跑完时，下一次累加会把
 * `reading:` 里的旧值再加一遍。
 */
export async function writeDayReading(date: string, seconds: number): Promise<void> {
  const value = Math.floor(seconds)
  if (value <= 0) return

  const legacy = await readLegacyReading(date)
  await updateDayFile(date, (cur) => {
    const next: DayFile = { ...(cur ?? { date }), readingSeconds: value }
    if (legacy !== null) next.legacyReading = legacy
    return next
  })
}

/**
 * 只删学习快照，保留阅读秒数（「删除某天记录」的语义）。
 * 那天只有快照没有秒数时，整个文件删掉。
 */
export async function clearDaySnapshot(date: string): Promise<void> {
  await queueByKey(dayPath(date), async () => {
    const cur = await readDayFile(date)
    if (cur?.readingSeconds === undefined) {
      await removeFile(dayPath(date))
      return
    }
    await writeJson(dayPath(date), { date, readingSeconds: cur.readingSeconds })
  })
}

/** 整份删掉（含阅读秒数） */
export function removeDayFile(date: string): Promise<void> {
  return queueByKey(dayPath(date), () => removeFile(dayPath(date)))
}

/** 目录里所有日期（不含内容判断）。阅读时长只读这一层就够，不必先看快照 */
export async function listDayDates(): Promise<string[]> {
  const names = await listFileNames(SUBDIR)
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort()
}

/** 有学习快照的日期（升序）。只在 `day_index` 丢失时用来重建索引 */
export async function listSnapshotDates(): Promise<string[]> {
  const out: string[] = []
  for (const date of await listDayDates()) {
    const file = await readDayFile(date)
    if (file?.snapshot) out.push(date)
  }
  return out
}

/* ── 旧键读取（迁移完成前 / 迁移中断时的兜底） ───────────── */

export async function readLegacySnapshot(date: string): Promise<Record<string, unknown> | null> {
  const { value } = await Preferences.get({ key: LEGACY_DAY + date })
  return parseJsonObject(value)
}

export async function readLegacyReading(date: string): Promise<number | null> {
  const { value } = await Preferences.get({ key: LEGACY_READING + date })
  const n = Number(value)
  return value && Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/** 旧前缀的日期（升序）。`day_index` 丢失时与文件目录一起用来重建 */
export async function legacyDayDates(): Promise<string[]> {
  const { keys } = await Preferences.keys()
  const dates = new Set<string>()
  for (const k of keys) {
    if (k.startsWith(LEGACY_DAY)) dates.add(k.slice(LEGACY_DAY.length))
    else if (k.startsWith(LEGACY_READING)) dates.add(k.slice(LEGACY_READING.length))
  }
  return [...dates].sort()
}

/** 清空全部旧键（「清空全部记录」用） */
export async function removeLegacyDayKeys(): Promise<void> {
  await removeLegacyKeys(await legacyKeys([LEGACY_DAY, LEGACY_READING]))
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/* ── 一次性迁移 ──────────────────────────────── */

/**
 * 把旧键搬进文件。每个会话最多试一次；中途失败不写标记，下次启动整体重试。
 * 部分迁移是安全的：读取路径一律文件优先、旧键兜底，两边谁有数据都能读出来。
 */
const runMigrateOnce = createOnceTask(async () => {
  if (await isMigrated(K_MIGRATED)) return
  await migrateOnce()
})

export function ensureDayFiles(): Promise<void> {
  return runMigrateOnce()
}

async function migrateOnce(): Promise<void> {
  const keys = await legacyKeys([LEGACY_DAY, LEGACY_READING])
  if (keys.length === 0) {
    await markMigrated(K_MIGRATED)
    return
  }

  const dates = [...new Set(keys.map((k) => k.slice(k.indexOf(':') + 1)))].sort()
  const batch = dates.slice(0, BATCH)

  // 先落原件：这批旧键原样存一份，搬坏了还有东西可查
  await writeSafetyDump(batch)

  for (const date of batch) await migrateDay(date)

  if (dates.length <= BATCH) await markMigrated(K_MIGRATED)
}

/**
 * 搬迁一批旧键的原始内容。
 *
 * 为什么先做这一步：迁移是本 App 唯一一次「删用户数据所在键」的操作。
 * 副本写不出来（或写出来读不回）就整批不搬——宁可留在慢的存储里，也不能冒丢一份的风险。
 */
async function writeSafetyDump(dates: string[]): Promise<void> {
  const legacy: Record<string, string> = {}
  for (const date of dates) {
    for (const prefix of [LEGACY_DAY, LEGACY_READING]) {
      const { value } = await Preferences.get({ key: prefix + date })
      if (value !== null) legacy[prefix + date] = value
    }
  }

  const path = `${SAFETY_DIR}/legacy-${dates[0]}_${dates[dates.length - 1]}.json`
  const payload = { at: new Date().toISOString(), legacy }
  await writeVerifiedDump(
    path,
    payload,
    (back) => sameRecord(back?.legacy, legacy),
    '迁移副本校验失败',
  )
}

async function migrateDay(date: string): Promise<void> {
  const [dayValue, readingValue] = await Promise.all([
    Preferences.get({ key: LEGACY_DAY + date }).then((r) => r.value),
    Preferences.get({ key: LEGACY_READING + date }).then((r) => r.value),
  ])

  const rawSnapshot = dayValue ? parseJsonObject(dayValue) : null
  const seconds = await readLegacyReading(date)

  await updateDayFile(date, (cur) => {
    const next: DayFile = { ...(cur ?? { date }) }
    let changed = false
    if (rawSnapshot && !next.snapshot) {
      // 旧数据里可能是更早的词表结构，原样存，读的时候由 store 的 normalize 兼容
      next.snapshot = rawSnapshot as unknown as TodaySnapshot
      changed = true
    }
    // legacyReading 相同 = 上一次已经并过了（只在删键前中断过），不能重复累加
    if (seconds !== null && next.legacyReading !== seconds) {
      next.readingSeconds = (next.readingSeconds ?? 0) + seconds
      next.legacyReading = seconds
      changed = true
    }
    return changed ? next : null
  })

  // 写完读回来验一遍：文件里确实有这份数据，才敢删旧键
  const check = await readDayFile(date)
  const snapshotOk = !rawSnapshot || Boolean(check?.snapshot)
  const secondsOk = seconds === null || (check?.readingSeconds ?? 0) >= seconds
  if (!snapshotOk || !secondsOk) throw new Error(`每日记录迁移校验失败：${date}`)

  const done: string[] = []
  if (dayValue !== null) done.push(LEGACY_DAY + date)
  if (readingValue !== null) done.push(LEGACY_READING + date)
  await removeLegacyKeys(done)
}
