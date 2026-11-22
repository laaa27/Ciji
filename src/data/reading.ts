import { addDayReading, legacyDayDates, listDayDates, readDayReading, writeDayReading } from '@/data/dayFile'

/**
 * 阅读时长的数据层：一天一个数字，存在当天的日文件里（`days/YYYY-MM-DD.json`
 * 的 `readingSeconds` 字段），与学习快照同住，不再单独占一个 Preferences 键。
 *
 * 为什么合并：阅读秒数每 15~60 秒就要落一次盘，而 Preferences 每写任意一个键都会
 * 整份重写那个共用 XML。搬进文件后，一次落盘只重写当天那 23 KB。
 * 旧键 `reading:YYYY-MM-DD` 由 `data/dayFile.ts` 的迁移搬进来，读的时候兜底。
 */

/** 读某天的累计阅读秒数；没有记录或值损坏时按 0 算 */
export async function getReadingSeconds(date: string): Promise<number> {
  return readDayReading(date)
}

/** 给某天累加阅读秒数。调用方按批次写入（一分钟一次），不用担心并发踩踏 */
export async function addReadingSeconds(date: string, sec: number): Promise<void> {
  await addDayReading(date, sec)
}

/** 导入用：把某天的累计秒数设成绝对值（不是累加） */
export async function setReadingSeconds(date: string, sec: number): Promise<void> {
  await writeDayReading(date, sec)
}

export type ReadingDay = { date: string; seconds: number }

/**
 * 全部有阅读记录的日期，按倒序（最新在前）。
 *
 * 日期取「文件目录 ∪ 旧键」的并集：迁移是分几轮跑的，一次启动只搬一批，
 * 还没轮到的日子只在旧键里——只列目录的话，统计页会在迁移期间少显示几天，
 * 看起来就像数据丢了。秒数仍然文件优先、旧键兜底，两边有值也不会重复累加。
 */
export async function getAllReadingDays(): Promise<ReadingDay[]> {
  const dates = new Set([...(await listDayDates()), ...(await legacyDayDates())])
  const out: ReadingDay[] = []
  for (const date of dates) {
    const seconds = await readDayReading(date)
    if (seconds > 0) out.push({ date, seconds })
  }
  return out.sort((a, b) => b.date.localeCompare(a.date))
}
