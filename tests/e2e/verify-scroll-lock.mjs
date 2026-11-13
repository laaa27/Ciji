import puppeteer from 'puppeteer-core'

/**
 * 词卡弹层打开期间的滚动锁定。
 *
 * 背景：遮罩是 position: fixed，但 DOM 上仍是 `.body`（App 的滚动容器）的后代，
 * 触摸滑动会顺着祖先链找到 `.body`，于是弹层开着背景照样跟着滚 —— 而且滚的不是
 * 当前视图，手感比平时更冲；底栏那一带摸上去也是同一个穿透滚动。
 *
 * 修法：打开时把 `[data-scroller]` 的 overflowY 设成 hidden，关闭时还原；
 * 弹层自身（.sheet）超出屏幕时自己滚。
 *
 *   npx vite preview --port 5199   （先 npm run build）
 *   node tests/e2e/verify-scroll-lock.mjs
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

const dateKey = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const TODAY = dateKey(new Date())

/** 足够长的一篇文章：40 句，保证页面能滚 */
const SENTENCES = Array.from({ length: 40 }, (_, i) => ({
  en: `Sentence ${i + 1} walks through a pharaoh's room and counts the quiet hours nobody remembers.`,
  zh: `第 ${i + 1} 句。`,
}))

const article = {
  id: `${TODAY}#1`,
  date: TODAY,
  title: 'The Long Room',
  titleZh: '长长的房间',
  sentences: SENTENCES,
  targetWords: ['pharaoh'],
  kinds: ['forget'],
  mode: 'weak',
  level: 'cet4',
  genre: 'expository',
  model: 'test / test',
  createdAt: new Date().toISOString(),
}

const meta = {
  id: article.id,
  date: TODAY,
  title: article.title,
  wordCount: 999,
  createdAt: article.createdAt,
}

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
  ({ article, meta }) => {
    localStorage.clear()
    localStorage.setItem('cjt.tab', 'reading')
    localStorage.setItem('CapacitorStorage.article:' + article.id, JSON.stringify(article))
    localStorage.setItem('CapacitorStorage.article_index', JSON.stringify([meta]))
    localStorage.setItem('CapacitorStorage.llm_profiles', '[]')
  },
  { article, meta },
)

await page.setRequestInterception(true)
page.on('request', (req) => {
  if (!req.url().includes('/open/')) return req.continue()
  req.respond({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: { records: [], count: 0, voc: [] } }),
  })
})

await page.reload({ waitUntil: 'networkidle0' })
await t(900)

const overflowY = () =>
  page.evaluate(() => {
    const s = document.querySelector('[data-scroller]')
    return s ? getComputedStyle(s).overflowY : 'missing'
  })

const scrollTop = () =>
  page.evaluate(() => document.querySelector('[data-scroller]')?.scrollTop ?? -1)

/** 用真实滚轮滚一段，返回 scrollTop 的变化量 */
async function wheelAt(y, deltaY = 400) {
  const before = await scrollTop()
  await page.mouse.move(195, y)
  await page.mouse.wheel({ deltaY })
  await t(350)
  return (await scrollTop()) - before
}

console.log('\n[1] 弹层出现前：页面正常可滚')
ok('overflowY 是 auto', (await overflowY()) === 'auto', await overflowY())
ok('滚轮能滚', (await wheelAt(500)) > 0, `delta=${await scrollTop()}`)

console.log('\n[2] 点词打开弹层')
const opened = await page.evaluate(() => {
  const btn = document.querySelector('[data-target], button')
  const words = [...document.querySelectorAll('button')].filter((b) =>
    /^[A-Za-z][A-Za-z'\u2019-]*$/.test(b.textContent ?? ''),
  )
  const pick = words.find((b) => b.textContent?.includes("pharaoh's")) ?? words[0] ?? btn
  if (!pick) return null
  pick.click()
  return pick.textContent
})
await t(450)
ok('弹层打开（点到了正文里的词）', Boolean(opened), String(opened))
ok('弹层渲染出来了', await page.evaluate(() => Boolean(document.querySelector('[role="dialog"]'))))

console.log('\n[3] 弹层打开期间：背景被锁住')
ok('overflowY 变成 hidden', (await overflowY()) === 'hidden', await overflowY())
const inArticle = await wheelAt(500)
ok('在正文区域滑动不再带动背景', inArticle === 0, `delta=${inArticle}`)
const onTabBar = await wheelAt(800)
ok('在底栏那一带滑动也不带动背景', onTabBar === 0, `delta=${onTabBar}`)

const sheet = await page.evaluate(() => {
  const el = document.querySelector('[role="dialog"]')
  if (!el) return null
  const cs = getComputedStyle(el)
  return { overflowY: cs.overflowY, maxHeight: cs.maxHeight, touch: cs.touchAction }
})
ok('弹层自身可滚（overflow-y: auto）', sheet?.overflowY === 'auto', JSON.stringify(sheet))
ok('弹层有高度上限（不会溢出屏幕）', sheet?.maxHeight !== 'none', JSON.stringify(sheet))

console.log('\n[4] 关闭后恢复')
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
    b.textContent?.includes('关闭'),
  )
  if (btn) btn.click()
})
await t(400)
ok('弹层已卸载', await page.evaluate(() => !document.querySelector('[role="dialog"]')))
ok('overflowY 还原成 auto', (await overflowY()) === 'auto', await overflowY())
ok('滚轮恢复可滚', (await wheelAt(500)) > 0)

console.log('\n[5] 没有页面报错')
ok('无 pageerror', errors.length === 0, errors.join(' | '))

console.log(`\n结果：${pass} 过，${fail} 挂`)
await browser.close()
process.exit(fail)
