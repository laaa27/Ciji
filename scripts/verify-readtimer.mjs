import puppeteer from 'puppeteer-core'

/**
 * 阅读计时器 + 统计页阅读时长图表的浏览器验证。
 *
 * 先 `npx vite --port 5199`，再 `node scripts/verify-readtimer.mjs`
 *
 * 覆盖：
 *   1. 预置若干天 reading:YYYY-MM-DD 记录 + 学习快照 → 统计页出现「阅读时长」图表
 *   2. 图表柱子/提示文案的数值与预置数据对得上
 *   3. 阅读页顶栏计时器显示预置的今日秒数，并且在走秒
 *   4. 无阅读记录时统计页给出「还没有阅读记录」提示（不是整个板块消失）
 */

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5199/'

const t = (ms) => new Promise((r) => setTimeout(r, ms))

function dateKey(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

// 预置：今天 95 秒 + 昨天 10 分钟 + 前天 25 分钟
const READ_SEED = [
  { date: dateKey(0), seconds: 95 },
  { date: dateKey(1), seconds: 600 },
  { date: dateKey(2), seconds: 1500 },
]

// 学习快照：统计页的基本门槛（有记录才渲染正文板块）
const DAY_SEED = [
  {
    date: dateKey(0),
    finished: 10,
    total: 12,
    studyTimeMs: 180000,
    collectedAt: new Date().toISOString(),
    words: [
      {
        vocId: 'v1',
        spelling: 'abandon',
        groups: ['forget'],
        isNew: true,
        firstResponse: 'FORGET',
        lastResponse: 'FORGET',
        isFinished: true,
        order: 1,
      },
    ],
    rawCount: 1,
    studiedCount: 1,
  },
]

// 样例文章：阅读页计时需要「有文章打开」才开始走
const ARTICLE = {
  id: dateKey(0) + '#1',
  date: dateKey(0),
  title: 'The Quiet Architecture of Habit',
  titleZh: '习惯的静默建筑',
  sentences: [
    {
      en: 'We tend to imagine that character is forged in moments of crisis.',
      zh: '我们总以为性格是在危机时刻锻造的。',
    },
    {
      en: 'In reality it is built in the unremarkable hours.',
      zh: '实际上，它是在那些平淡无奇的时刻里建成的。',
    },
  ],
  targetWords: ['concede', 'prevalent'],
  mode: 'weak',
  level: 'kaoyan',
  model: 'glm-4-flash',
  createdAt: new Date().toISOString(),
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
})

const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1
    console.log('  ✓', name)
  } else {
    fail += 1
    console.log('  ✗', name, extra ?? '')
  }
}

await page.goto(URL, { waitUntil: 'networkidle0' })

// ── 预置数据 ─────────────────────────────
await page.evaluate(
  (reads, day, article) => {
    for (const r of reads) {
      localStorage.setItem('CapacitorStorage.reading:' + r.date, String(r.seconds))
    }
    localStorage.setItem('CapacitorStorage.day:' + day.date, JSON.stringify(day))
    localStorage.setItem('CapacitorStorage.article:' + article.id, JSON.stringify(article))
    localStorage.setItem(
      'CapacitorStorage.article_index',
      JSON.stringify([{ id: article.id, date: article.date, title: article.title }]),
    )
    localStorage.setItem('CapacitorStorage.llm_key', 'seed-key-for-layout-only')
  },
  READ_SEED,
  DAY_SEED[0],
  ARTICLE,
)
await page.reload({ waitUntil: 'networkidle0' })
await t(800)

// ── 1. 统计页 ────────────────────────────
console.log('▸ 统计页')
const tabs = await page.$$('nav button')
await tabs[3].click() // stats
await t(900)

const stats = await page.evaluate(() => {
  const sections = [...document.querySelectorAll('h2')].map((h) => h.textContent?.trim())
  const body = document.body.innerText
  return { sections, body }
})

ok('出现「阅读时长」板块', stats.sections.includes('阅读时长'), JSON.stringify(stats.sections))

// 95 + 600 + 1500 = 2195 秒 = 36 分 35 秒
ok(
  '累计文案 36 分 35 秒',
  stats.body.includes('36 分 35 秒'),
  (stats.body.match(/累计[^\n]*/) ?? [''])[0],
)
ok('最近一天提示 1 分 35 秒', stats.body.includes('1 分 35 秒'))

// 图表 canvas 是否真的画了
const chartBox = await page.evaluate(() => {
  const h2 = [...document.querySelectorAll('h2')].find((h) => h.textContent?.trim() === '阅读时长')
  const section = h2?.parentElement
  const canvas = section?.querySelector('canvas')
  if (!canvas) return null
  const r = canvas.getBoundingClientRect()
  return { w: Math.round(r.width), h: Math.round(r.height) }
})
ok('阅读时长图表 canvas 存在且有尺寸', Boolean(chartBox && chartBox.w > 100 && chartBox.h > 50), JSON.stringify(chartBox))

await page.screenshot({ path: 'verify-stats.png' })

// ── 2. 阅读页计时器 ──────────────────────
console.log('▸ 阅读页')
const tabs2 = await page.$$('nav button')
await tabs2[2].click() // reading
await t(900)

const timerText = await page.evaluate(() => {
  const el = document.querySelector('[aria-label="今日阅读时长"]')
  return el ? el.textContent?.trim() : null
})
ok('顶栏计时器存在', timerText !== null, '元素未找到')
ok('显示预置的 95 秒（01:35）', timerText === '01:35', `实际=${timerText}`)

// 等它走秒
await t(2600)
const timerText2 = await page.evaluate(() => {
  const el = document.querySelector('[aria-label="今日阅读时长"]')
  return el ? el.textContent?.trim() : null
})
ok('计时器在走秒', timerText2 !== timerText, `${timerText} → ${timerText2}`)

// 落盘验证：会话秒数离开计时状态时要写进 localStorage
const tabs3 = await page.$$('nav button')
await tabs3[3].click() // 切走触发 flush
await t(600)
const stored = await page.evaluate(() => {
  const keys = Object.keys(localStorage).filter((k) => k.includes('reading:'))
  return keys.map((k) => [k, localStorage.getItem(k)])
})
const todayRec = stored.find(([k]) => k.endsWith(dateKey(0)))
ok(
  '切走栏目后会话时长落盘',
  Boolean(todayRec && Number(todayRec[1]) > 95),
  JSON.stringify(stored),
)

await page.screenshot({ path: 'verify-reading.png' })

// ── 3. 无阅读记录时：板块仍在，给出提示 ──
console.log('▸ 空记录场景')
await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    if (k.includes('reading:')) localStorage.removeItem(k)
  }
})
await page.reload({ waitUntil: 'networkidle0' })
await t(800)
const tabs4 = await page.$$('nav button')
await tabs4[3].click() // stats
await t(900)
const empty = await page.evaluate(() => {
  const sections = [...document.querySelectorAll('h2')].map((h) => h.textContent?.trim())
  return { hasSection: sections.includes('阅读时长'), body: document.body.innerText }
})
ok('无记录时板块仍存在', empty.hasSection)
ok('无记录时显示引导提示', empty.body.includes('还没有阅读记录'))

console.log(`\n结果：${pass} 过，${fail} 挂`)
await browser.close()
process.exit(fail > 0 ? 1 : 0)
