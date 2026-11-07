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
