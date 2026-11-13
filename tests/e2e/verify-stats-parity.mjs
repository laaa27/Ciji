import puppeteer from 'puppeteer-core'

/**
 * 今日页与统计页的计数口径一致性。
 *
 * 背景：统计页原先自己算两套 —— 柱状图按 `lineState`（看反馈）、摘要按
 * `isNew` + `firstResponse`（允许重叠）。一个「新学但答错」的词在今日页算新学、
 * 在统计页算忘记，两页永远差几个数。现在两边都走 `groupCounts`（互斥分组）。
 *
 * 造的数据刻意让两套口径给出不同答案：
 *   今天：3 个新学词（答错/模糊/认识各一）+ 1 个复习忘记词
 *         今日页 3/0/1；新口径累计 3/1/2；旧口径累计 3/2/3
 *
 *   npx vite preview --port 5199   （先 npm run build）
 *   node tests/e2e/verify-stats-parity.mjs
 */

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP = process.env.PREVIEW_URL || 'http://localhost:5199/'

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

const t = (ms) => new Promise((r) => setTimeout(r, ms))

/** 本地时区的 YYYY-MM-DD，和 lib/date.ts 的 dateKey 同一口径 */
const dateKey = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const TODAY = dateKey(new Date())
const YESTERDAY = dateKey(new Date(Date.now() - 86400000))

const word = (spelling, groups, isNew, firstResponse) => ({
  vocId: `v-${spelling}`,
  spelling,
  groups,
  isNew,
  firstResponse,
  isFinished: true,
  order: 0,
})

const snapToday = {
  date: TODAY,
  finished: 4,
  total: 4,
  studyTimeMs: 600000,
  // 三个新学词分别答了忘记 / 模糊 / 认识：互斥口径下都不进模糊、忘记组
  words: [
    word('delta', ['new'], true, 'FORGET'),
    word('echo', ['new'], true, 'VAGUE'),
    word('foxtrot', ['new'], true, 'FAMILIAR'),
    word('pharaoh', ['forget'], false, 'FORGET'),
  ],
  collectedAt: new Date().toISOString(),
  rawCount: 4,
  studiedCount: 4,
}

const snapYesterday = {
  date: YESTERDAY,
  finished: 2,
  total: 2,
  studyTimeMs: 300000,
  words: [word('pharaoh', ['forget'], false, 'FORGET'), word('amber', ['vague'], false, 'VAGUE')],
  collectedAt: new Date().toISOString(),
  rawCount: 2,
  studiedCount: 2,
}

/** 墨墨接口形态的今日词条：与上面的快照同源，刷新后快照不会被冲掉 */
const todayItems = snapToday.words.map((w, i) => ({
  voc_id: w.vocId,
  voc_spelling: w.spelling,
  first_response: w.firstResponse,
  is_new: w.isNew,
  is_finished: true,
  order: i,
}))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })

const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(APP, { waitUntil: 'domcontentloaded' })
await page.evaluate(
  ({ today, yesterday }) => {
    localStorage.clear()
    localStorage.setItem('CapacitorStorage.maimemo_token', 'seed')
    localStorage.setItem('CapacitorStorage.day:' + today.date, JSON.stringify(today))
    localStorage.setItem('CapacitorStorage.day:' + yesterday.date, JSON.stringify(yesterday))
  },
  { today: snapToday, yesterday: snapYesterday },
)

await page.setRequestInterception(true)
page.on('request', (req) => {
  if (!req.url().includes('/open/')) return req.continue()
  const json = (body) =>
    req.respond({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: body }),
    })
  if (req.url().includes('get_study_progress')) {
    return json({ progress: { finished: 4, total: 4, study_time: 600000 } })
  }
  if (req.url().includes('get_today_items')) return json({ today_items: todayItems })
  return json({ records: [], count: 0, voc: [] })
})

await page.reload({ waitUntil: 'networkidle0' })
await t(900)

const clickTab = (label) =>
  page.evaluate((text) => {
    const btn = [...document.querySelectorAll('nav button')].find((b) =>
      b.textContent?.includes(text),
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, label)

console.log('\n[1] 今日页三组数字')
const todayCounts = await page.evaluate(() =>
  [...document.querySelectorAll('[data-group-head]')].map((h) => ({
    key: h.dataset.groupHead,
    n: Number(h.querySelector('span')?.textContent ?? -1),
  })),
)
const byKey = Object.fromEntries(todayCounts.map((c) => [c.key, c.n]))
ok('新学 3', byKey.new === 3, JSON.stringify(byKey))
ok('模糊 0（新学的词答了模糊也不算）', byKey.vague === 0, JSON.stringify(byKey))
ok('忘记 1', byKey.forget === 1, JSON.stringify(byKey))

console.log('\n[2] 统计页摘要（应为累计互斥口径 3 / 1 / 2）')
await clickTab('统计')
await t(700)

const summary = await page.evaluate(() => {
  const p = [...document.querySelectorAll('p')].find((x) => x.textContent?.includes('记录的'))
  if (!p) return ''
  return p.textContent.replace(/\s+/g, '')
})
ok('记录的 2 天里', summary.includes('记录的2天里'), summary)
ok('新学 3 个词', summary.includes('新学3个词'), summary)
ok('模糊 1 个（旧口径会给 2）', summary.includes('模糊1个'), summary)
ok('忘记 2 个（旧口径会给 3）', summary.includes('忘记2个'), summary)

console.log('\n[3] 反复忘记')
const stubborn = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find((x) => x.textContent?.includes('反复忘记'))
  if (!h) return []
  const ul = h.parentElement?.querySelector('ul')
  if (!ul) return []
  return [...ul.querySelectorAll('li')].map((li) => li.textContent.replace(/\s+/g, ''))
})
ok('pharaoh 记 2 次', stubborn.some((s) => s.includes('pharaoh') && s.includes('2次')), JSON.stringify(stubborn))
ok('新学词不进这张表', !stubborn.some((s) => s.includes('delta')), JSON.stringify(stubborn))

console.log('\n[4] 没有页面报错')
ok('无 pageerror', errors.length === 0, errors.join(' | '))

console.log(`\n结果：${pass} 过，${fail} 挂`)
await browser.close()
process.exit(fail)
