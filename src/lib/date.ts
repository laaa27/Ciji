/** 日期工具：统一按北京时间（UTC+8）计算，避免设备时区差异 */

const keyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const partsFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'long',
  day: 'numeric',
})

const weekdayFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  weekday: 'long',
})

/** YYYY-MM-DD（北京时间） */
export function dateKey(d: Date = new Date()): string {
  return keyFmt.format(d)
}

/** 11月7日 */
export function monthDay(key: string): string {
  const [y, m, day] = key.split('-').map(Number)
  if (!y || !m || !day) return key
  return partsFmt.format(new Date(Date.UTC(y, m - 1, day, 4)))
}

/** 星期六 */
export function weekday(key: string): string {
  const [y, m, day] = key.split('-').map(Number)
  if (!y || !m || !day) return ''
  return weekdayFmt.format(new Date(Date.UTC(y, m - 1, day, 4)))
}

/** 两个日期键相差天数（a - b） */
export function diffDays(a: string, b: string): number {
  const t1 = Date.parse(`${a}T00:00:00+08:00`)
  const t2 = Date.parse(`${b}T00:00:00+08:00`)
  return Math.round((t1 - t2) / 86_400_000)
}

/** 某月共几天（month 从 1 起） */
export function daysInMonth(year: number, month: number): number {
  // 下个月的第 0 天 = 本月最后一天。锚在 UTC 04:00（北京 12:00），
  // 这样任何时区下都不会被推到前一天或后一天
  return new Date(Date.UTC(year, month, 0, 4)).getUTCDate()
}

/** 某月 1 号是周几（0 = 周日），日历算首行要空几格 */
export function firstWeekday(year: number, month: number): number {
  return new Date(Date.UTC(year, month - 1, 1, 4)).getUTCDay()
}

/** 2026年11月 */
export function yearMonth(key: string): string {
  const [y, m] = key.split('-').map(Number)
  if (!y || !m) return key
  return `${y}年${m}月`
}

/** 把秒数排成 05:24 / 1:02:03 这样的表盘格式 */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** 10:54（北京时间） */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return timeFmt.format(d)
}
