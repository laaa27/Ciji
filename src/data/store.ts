import { Preferences } from '@capacitor/preferences'

import type { TodaySnapshot } from '@/domain/collect'

/**
 * 数据层：按天存一份快照。
 *
 * 为什么不用 SQLite：一天一条记录，一年才 365 条，
 * 用 Preferences（原生走 SharedPreferences，web 走 localStorage）足够，
 * 且两个平台行为一致，不需要 wasm 和平台分支。
 *
 * 存储键：day:YYYY-MM-DD
 */

const DAY_PREFIX = 'day:'

function dayKey(date: string): string {
  return DAY_PREFIX + date
}

/** 写入某天快照；同一天重复写入直接覆盖（天然幂等） */
export async function saveDay(snapshot: TodaySnapshot): Promise<void> {
  await Preferences.set({
    key: dayKey(snapshot.date),
    value: JSON.stringify(snapshot),
  })
}

export async function getDay(date: string): Promise<TodaySnapshot | null> {
  const { value } = await Preferences.get({ key: dayKey(date) })
  if (!value) return null
  try {
    return JSON.parse(value) as TodaySnapshot
  } catch {
    return null
  }
}

/** 所有已记录的日期，按倒序（最新在前） */
export async function listDays(): Promise<string[]> {
  const { keys } = await Preferences.keys()
  return keys
    .filter((k) => k.startsWith(DAY_PREFIX))
    .map((k) => k.slice(DAY_PREFIX.length))
    .sort()
    .reverse()
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

export async function deleteDay(date: string): Promise<void> {
  await Preferences.remove({ key: dayKey(date) })
}

/** 清空全部历史 */
export async function clearAll(): Promise<void> {
  const days = await listDays()
  await Promise.all(days.map((d) => deleteDay(d)))
}
