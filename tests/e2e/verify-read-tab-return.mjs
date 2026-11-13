import puppeteer from 'puppeteer-core'

/**
 * 「切到别的栏目再回到阅读，位置必须原地」的回归。
 *
 * 触发条件很挑（所以这个 bug 活了很久）：**目标栏目要足够高**，高到能把阅读页的
 * scrollTop 夹出一个非零值。
 *
 * 成因：阅读页落盘阅读位置是在 effect 的 cleanup 里做的，而 cleanup 跑在 React 提交
 * 之后 —— 那时 `.body` 里换成了目标栏目的内容、阅读页 display:none，浏览器已经把
 * scrollTop 夹进新容器的可滚范围。统计页（摘要 + 两张图 + 反复忘记）正好高到能夹出
 * 一个非零中间值（实测 2400 → 517），那个值被当成阅读位置存下来；返回阅读时
 * restoreScroll 反过来用 517 把页面拽回去，位置就乱了。今日 / 设置 / 历史首页比阅读页
 * 矮得多，夹出来是 0，而 restoreScroll 对 0 直接跳过 —— 所以只有统计页露馅。
 *
 * 修法：滚动时把「最后看到的位置」记在 ref 里（页面不可见期间的 scroll 事件一律忽略），
 * 落盘与恢复都用它，不再读被夹过的 scrollTop。
 *
 * 前置：`npm run build` + `npx vite preview --port 5199`（用的是 dist 产物）
 *   node tests/e2e/verify-read-tab-return.mjs
 */

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = process.env.PREVIEW_URL || 'http://localhost:5199/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date())

/** 40 句，保证阅读页能滚到 2400 以下还有余量 */
const ARTICLE = {
  id: `${today}#tabreturn`,
  date: today,
  title: 'The Quiet Cost of Convenience',
  titleZh: '便利的隐性代价',
  sentences: Array.from({ length: 40 }, (_, i) => ({
    en: `Sentence ${i + 1} argues that convenience, once adopted, quietly reshapes the habits of the people who depend on it.`,
    zh: `第 ${i + 1} 句认为便利会悄悄重塑习惯。`,
  })),
  targetWords: ['convenience'],
  mode: 'weak',
  level: 'kaoyan',
  model: 'seed',
  createdAt: new Date().toISOString(),
}

/**
 * 每天 12 个词，用来撑高统计页的「反复忘记」列表（复现前提）。
 * **必须是本地词典里真有的词**：造词会触发 MyMemory 兜底，而这个免费接口实测
 * 单次要 0.6~13 秒，会让 networkidle 一直等不到（本脚本踩过）。
 */
const REAL_WORDS = [
  'file', 'site', 'sites', 'filing', 'pharaoh', 'abandon',
  'box', 'watch', 'dish', 'note', 'leaf', 'budget',
]

function makeDay(dateKey) {
  const words = REAL_WORDS.map((spelling, i) => ({
    vocId: `f${i}`,
    spelling,
    groups: ['forget'],
    isNew: false,
    firstResponse: 'FORGET',
    isFinished: true,
    order: i,
  }))
  return {
    date: dateKey,
    finished: 12,
    total: 60,
    studyTimeMs: 600000,
    collectedAt: new Date().toISOString(),
    rawCount: 12,
    studiedCount: 12,
    words,
  }
}

const days = []
for (let i = 0; i < 40; i += 1) {
  const d = new Date(Date.now() - i * 86400000)
  const key = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
  days.push(makeDay(key))
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })

const errors = []
page.on('pageerror', (e) => errors.push(e.message))

await page.goto(APP, { waitUntil: 'networkidle0' })
await page.evaluate(
  ({ article, days }) => {
    localStorage.clear()
    localStorage.setItem('CapacitorStorage.article:' + article.id, JSON.stringify(article))
    localStorage.setItem(
      'CapacitorStorage.article_index',
      JSON.stringify([{ id: article.id, date: article.date, title: article.title }]),
    )
    for (const d of days) localStorage.setItem('CapacitorStorage.day:' + d.date, JSON.stringify(d))
  },
  { article: ARTICLE, days },
)
await page.reload({ waitUntil: 'networkidle0' })
await sleep(900)

const top = () => page.evaluate(() => Math.round(document.querySelector('[data-scroller]').scrollTop))
const maxScroll = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-scroller]')
    return el.scrollHeight - el.clientHeight
  })
const savedPos = () =>
  page.evaluate((id) => Number(localStorage.getItem('cjt.read.' + id) ?? -1), ARTICLE.id)
const clickTab = async (i) => {
  const tabs = await page.$$('nav button')
  await tabs[i].click()
}
const setTop = async (y) => {
  await page.evaluate((t) => {
    const el = document.querySelector('[data-scroller]')
    el.scrollTop = t
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
  }, y)
  await sleep(600)
}

// 统计页先访问一次：日常使用时它早就挂载过、内容也齐了，
// 只有这个状态才会夹出非零值 —— 首次进入时它还在「读取中」，反而复现不了
console.log('\n[0] 预热统计页（复现前提：它已挂载且内容完整）')
await clickTab(3)
await sleep(1500)
const statsMax = await maxScroll()
ok('统计页够高，能夹出非零滚动位置', statsMax > 300, String(statsMax))

console.log('\n[1] 阅读页滚到 2400，依次切四个栏目再回来')
const TARGET = 2400
for (const [label, idx] of [
  ['统计', 3],
  ['今日', 0],
  ['历史', 1],
  ['设置', 4],
]) {
  await clickTab(2)
  await sleep(900)
  await setTop(TARGET)
  const before = await top()

  await clickTab(idx)
  await sleep(1200)
  const awayMax = await maxScroll()
  const savedAway = await savedPos()

  await clickTab(2)
  await sleep(1200)
  const back = await top()

  ok(
    `${label}：回来还在 ${before}`,
    Math.abs(back - before) <= 40,
    `${before} → ${back}（切走时该栏目可滚 ${awayMax}）`,
  )
  ok(
    `${label}：切走期间阅读位置没被写成裁剪值`,
    Math.abs(savedAway - before) <= 40,
    `落盘 ${savedAway}，应为 ${before}`,
  )
}

console.log('\n[2] 快速往返（不给 restoreScroll 的重试留时间）')
await clickTab(2)
await sleep(900)
await setTop(TARGET)
const beforeFast = await top()
await clickTab(3)
await sleep(200)
await clickTab(2)
await sleep(1200)
const afterFast = await top()
ok('快速切到统计再回来仍保住', Math.abs(afterFast - beforeFast) <= 40, `${beforeFast} → ${afterFast}`)

console.log('\n[3] 刷新页面（冷启动）仍能回到原处')
await page.reload({ waitUntil: 'networkidle0' })
await sleep(1500)
const afterReload = await top()
ok('冷启动按落盘位置恢复', Math.abs(afterReload - beforeFast) <= 60, `${beforeFast} → ${afterReload}`)

console.log('\n[4] 没有页面报错')
ok('无 pageerror', errors.length === 0, errors.join(' | '))

await browser.close()
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail > 0 ? 1 : 0)
