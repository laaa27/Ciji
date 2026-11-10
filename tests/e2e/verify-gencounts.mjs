import puppeteer from 'puppeteer-core'

/**
 * 生成页类型计数口径的验证。
 *
 * 先 `npx vite --port 5199`，再 `node tests/e2e/verify-gencounts.mjs`
 *
 * 场景：某天 8 个词，其中 3 个已被当天文章用过。
 *   - 开关关闭：类型框显示「未用/总数」（如 2/3），已选只含未用词
 *   - 开关打开：类型框同步成全量数（3），已用词出现并带「已用」标
 *   - 开关再关闭：已用词从选择里摘掉，计数回到「未用/总数」
 */

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5199/'

const t = (ms) => new Promise((r) => setTimeout(r, ms))

function dateKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

const TODAY = dateKey()

// 8 个词，3 个已被文章用过（abandon / coherent / prevalent）
const WORDS = [
  ['abandon', ['forget'], true],
  ['scrutiny', ['forget'], false],
  ['coherent', ['vague'], true],
  ['eloquent', ['vague', 'new'], false],
  ['prevalent', ['new'], true],
  ['concede', ['new'], false],
  ['reluctant', ['forget'], false],
  ['ambiguous', ['vague'], false],
]

const KIND_MAP = { forget: 'FORGET', vague: 'VAGUE', new: 'FAMILIAR' }

const snapshot = {
  date: TODAY,
  finished: WORDS.length,
  total: WORDS.length,
  studyTimeMs: 60_000,
  collectedAt: new Date().toISOString(),
  words: WORDS.map(([spelling, kinds], i) => ({
    vocId: `v-${i}`,
    spelling,
    groups: kinds,
    isNew: kinds.includes('new'),
    firstResponse: KIND_MAP[kinds[0]],
    lastResponse: KIND_MAP[kinds[0]],
    isFinished: true,
    order: i,
  })),
  rawCount: WORDS.length,
  studiedCount: WORDS.length,
}

const article = {
  id: TODAY + '#1',
  date: TODAY,
  title: 'The Quiet Architecture of Habit',
  titleZh: '习惯的静默建筑',
  sentences: [
    { en: 'We tend to imagine that character is forged in moments of crisis.', zh: '我们总以为性格是在危机时刻锻造的。' },
  ],
  // 正是这三个词被「用过」
  targetWords: ['abandon', 'coherent', 'prevalent'],
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
await page.evaluate(
  (snap, art) => {
    localStorage.setItem('CapacitorStorage.day:' + snap.date, JSON.stringify(snap))
    localStorage.setItem('CapacitorStorage.article:' + art.id, JSON.stringify(art))
    localStorage.setItem('CapacitorStorage.llm_key', 'seed-key-for-layout-only')
  },
  snapshot,
  article,
)
await page.reload({ waitUntil: 'networkidle0' })
await t(800)

// 进阅读页 → 打开生成页
const tabs = await page.$$('nav button')
await tabs[2].click()
await t(600)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '生成')
  if (btn) btn.click()
})
await t(600)

const readCounts = () =>
  page.evaluate(() => {
    const kinds = [...document.querySelectorAll('button')]
      .filter((b) => b.querySelector('span[class*="tick"]'))
      .map((b) => b.textContent?.replace(/\s+/g, ' ').trim())
    const count = document.querySelector('header [class*="count"]')?.textContent?.trim()
    const usedBadges = [...document.querySelectorAll('li span')].filter((s) =>
      s.textContent?.trim() === '已用',
    ).length
    return { kinds, count, usedBadges }
  })

console.log('▸ 开关关闭（默认）')
let s = await readCounts()
ok('忘记显示 2/3', s.kinds.some((k) => k.includes('忘记') && k.includes('2/3')), JSON.stringify(s.kinds))
ok('模糊显示 1/2（coherent 已用；eloquent 分离后只算新学）', s.kinds.some((k) => k.includes('模糊') && k.includes('1/2')), JSON.stringify(s.kinds))
ok('新学显示 2/3', s.kinds.some((k) => k.includes('新学') && k.includes('2/3')), JSON.stringify(s.kinds))
ok('已选 = 5（只含未用词）', s.count === '已选 5', `实际=${s.count}`)
ok('列表里没有「已用」标', s.usedBadges === 0, `实际=${s.usedBadges}`)

console.log('▸ 打开「包含已用过的词」')
await page.evaluate(() => {
  const input = document.querySelector('input[class*="switch"]')
  if (input) input.click()
})
await t(500)
s = await readCounts()
ok('忘记同步为 3', s.kinds.some((k) => k.includes('忘记') && /3\s*$/.test(k)), JSON.stringify(s.kinds))
ok('模糊同步为 2', s.kinds.some((k) => k.includes('模糊') && /2\s*$/.test(k)), JSON.stringify(s.kinds))
ok('新学同步为 3', s.kinds.some((k) => k.includes('新学') && /3\s*$/.test(k)), JSON.stringify(s.kinds))
ok('出现 3 个「已用」标', s.usedBadges === 3, `实际=${s.usedBadges}`)
ok('已选不变（已用词需手动勾）', s.count === '已选 5', `实际=${s.count}`)

console.log('▸ 再关掉开关')
await page.evaluate(() => {
  const input = document.querySelector('input[class*="switch"]')
  if (input) input.click()
})
await t(500)
s = await readCounts()
ok('计数回到 2/3', s.kinds.some((k) => k.includes('忘记') && k.includes('2/3')), JSON.stringify(s.kinds))
ok('「已用」标消失', s.usedBadges === 0, `实际=${s.usedBadges}`)
ok('已选仍为 5', s.count === '已选 5', `实际=${s.count}`)

await page.screenshot({ path: 'verify-gencounts.png' })

console.log(`\n结果：${pass} 过，${fail} 挂`)
await browser.close()
process.exit(fail > 0 ? 1 : 0)
