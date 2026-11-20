import { readFileSync } from 'node:fs'

/**
 * 只读统计：不打印任何键的「值」，只出条数与体积。
 * 凭证类（token / llm_*）连名字都不细看，单独归一组。
 */
const FILE = process.argv[2]
const xml = readFileSync(FILE, 'utf8')

const re = /<string name="([^"]+)">([\s\S]*?)<\/string>/g
const items = []
let m
while ((m = re.exec(xml)) !== null) {
  items.push({ key: m[1], bytes: Buffer.byteLength(m[2], 'utf8') })
}

const groups = {
  'day:': [],
  'reading:': [],
  'gloss:': [],
  'gloss_alt:': [],
  'article:': [],
  其他: [],
}
const SENSITIVE = (k) => /token|llm|api|key|secret/i.test(k)

for (const it of items) {
  const g = Object.keys(groups).find((p) => p !== '其他' && it.key.startsWith(p))
  ;(g ? groups[g] : groups.其他).push(it)
}

const stat = (arr) => {
  if (arr.length === 0) return null
  const bytes = arr.reduce((n, x) => n + x.bytes, 0)
  const sizes = arr.map((x) => x.bytes).sort((a, b) => a - b)
  return {
    count: arr.length,
    totalKB: +(bytes / 1024).toFixed(1),
    min: sizes[0],
    avg: Math.round(bytes / arr.length),
    max: sizes[sizes.length - 1],
  }
}

console.log('XML 文件', (Buffer.byteLength(xml, 'utf8') / 1024).toFixed(1), 'KB /', items.length, '个键')
for (const [name, arr] of Object.entries(groups)) {
  const s = stat(arr)
  if (!s) continue
  console.log(
    `  ${name.padEnd(11)} 条数 ${String(s.count).padStart(4)} | 合计 ${String(s.totalKB).padStart(7)} KB | 单条 ${s.min}~${s.max} B（均 ${s.avg}）`,
  )
}

// 其他键：只给名字 + 体积 + 是否凭证，不给值
console.log('\n其余键（只列名字与体积）：')
groups.其他
  .sort((a, b) => b.bytes - a.bytes)
  .forEach((it) => {
    const tag = SENSITIVE(it.key) ? ' ← 凭证类，值未打印' : ''
    console.log(`  ${it.key.padEnd(32)} ${String(it.bytes).padStart(7)} B${tag}`)
  })

// 最大的 8 条（名字 + 体积，day/gloss 类无敏感内容）
console.log('\n最大的 8 条：')
items
  .slice()
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 8)
  .forEach((it) => console.log(`  ${it.key.padEnd(28)} ${it.bytes} B`))

// day 记录里各字段的占比（抽样最大的一条，只统计字段长度，不打印内容）
const dayItems = groups['day:'].slice().sort((a, b) => b.bytes - a.bytes)
if (dayItems.length) {
  const re2 = /<string name="([^"]+)">([\s\S]*?)<\/string>/g
  let sample = null
  let mm
  while ((mm = re2.exec(xml)) !== null) {
    if (mm[1] === dayItems[0].key) {
      sample = mm[2]
      break
    }
  }
  if (sample) {
    const decoded = sample
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
    try {
      const snap = JSON.parse(decoded)
      const words = Array.isArray(snap.words) ? snap.words : []
      console.log(
        `\n最大一天的构成：${snap.date} | 词 ${words.length} 个 | 整条 ${dayItems[0].bytes} B | 平均每词 ${Math.round(dayItems[0].bytes / Math.max(words.length, 1))} B`,
      )
      console.log('  日期键分布：', groups['day:'].slice(0, 3).map((x) => x.key.replace('day:', '')).join(' / '), '…')
    } catch {
      console.log('\n最大一天解析失败（跳过构成分析）')
    }
  }
}
