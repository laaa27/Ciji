import { Preferences } from '@capacitor/preferences'

/**
 * 阅读时长的数据层：一天一个键，存当天累计的阅读秒数。
 * 与学习快照分开存，互不干扰；写法与 store.ts 同一套路
 * （Preferences 原生走 SharedPreferences，web 走 localStorage）。
 *
 * 存储键：reading:YYYY-MM-DD，值为纯数字字符串（秒）
 */

const KEY_PREFIX = 'reading:'

function dayKey(date: string): string {
  return KEY_PREFIX + date
}

/** 读某天的累计阅读秒数；没有记录或值损坏时按 0 算 */
export async function getReadingSeconds(date: string): Promise<number> {
  const { value } = await Preferences.get({ key: dayKey(date) })
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 给某天累加阅读秒数。调用方按批次写入（十几秒一次），不用担心并发踩踏 */
export async function addReadingSeconds(date: string, sec: number): Promise<void> {
  if (sec <= 0) return
  const total = (await getReadingSeconds(date)) + sec
  await Preferences.set({ key: dayKey(date), value: String(Math.floor(total)) })
}

export type ReadingDay = { date: string; seconds: number }

/** 全部有阅读记录的日期，按倒序（最新在前） */
export async function getAllReadingDays(): Promise<ReadingDay[]> {
  const { keys } = await Preferences.keys()
  const dates = keys
    .filter((k) => k.startsWith(KEY_PREFIX))
    .map((k) => k.slice(KEY_PREFIX.length))
    .sort()
    .reverse()

  const out: ReadingDay[] = []
  for (const d of dates) {
    out.push({ date: d, seconds: await getReadingSeconds(d) })
  }
  return out
}
