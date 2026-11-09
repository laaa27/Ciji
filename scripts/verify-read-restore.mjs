import puppeteer from 'puppeteer-core'

/**
 * 阅读页「重启后回到原处」的回归：译文开启状态也必须一起恢复。
 *
 * 先 `vite preview --port 5199`，再 `node scripts/verify-read-restore.mjs`
 *
 * 这个用例对治一个真实 bug：
 * 译文只存在内存里（useState(false)），重启后必然变回关闭；
 * 而保存的滚动位置是「译文开」时的高度，按关闭状态渲染后，同一个像素坐标就落到别的文字上了。
 * 表现就是「译文自己关了、位置也不对」。所以两件事必须一起验。
 */

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = process.env.PREVIEW_URL || 'http://localhost:5199/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date())

/** 24 句，保证开译文后能滚到 800px 以下 */
const ARTICLE = {
  id: `${today}#restore`,
  date: today,
  title: 'The Quiet Cost of Convenience',
  titleZh: '便利的隐性代价',
  sentences: Array.from({ length: 24 }, (_, i) => ({
    en: `Sentence number ${i + 1} argues that convenience, once adopted, quietly reshapes the habits of the people who depend on it.`,
    zh: `第 ${i + 1} 句认为，便利一旦被采用，就会悄悄重塑依赖它的人的习惯。`,
  })),
  targetWords: ['convenience'],
  mode: 'weak',
  level: 'kaoyan',
  model: 'seed',
  createdAt: new Date().toISOString(),
}

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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })

await page.goto(APP, { waitUntil: 'networkidle0' })
await page.evaluate((article) => {
  localStorage.clear()
  localStorage.setItem('CapacitorStorage.article:' + article.id, JSON.stringify(article))
  localStorage.setItem(
    'CapacitorStorage.article_index',
    JSON.stringify([{ id: article.id, date: article.date, title: article.title }]),
  )
}, ARTICLE)
await page.reload({ waitUntil: 'networkidle0' })
await sleep(800)

const tabs = await page.$$('nav button')
await tabs[2].click()
await sleep(900)

/** 译文按钮的 data-on */
const zhOn = () =>
  page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '译文')
    return btn?.dataset.on === 'true'
  })

/** 滚动容器当前的 scrollTop */
const scrollerTop = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 100)
    return el ? Math.round(el.scrollTop) : -1
  })

const scrollTo = async (y) => {
  await page.evaluate((target) => {
    const el = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 100)
    if (el) el.scrollTop = target
    el?.dispatchEvent(new Event('scroll', { bubbles: true }))
  }, y)
  await sleep(500)
}

console.log('\n[1] 开译文并滚动')
ok('初始译文是关的', (await zhOn()) === false)

await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '译文')
  btn?.click()
})
await sleep(500)
ok('点一下译文 → 开', (await zhOn()) === true)

await scrollTo(820)
const before = await scrollerTop()
ok('确实滚下去了', before > 600, before)

console.log('\n[2] 模拟重启（reload，localStorage 保留）')
await page.reload({ waitUntil: 'networkidle0' })
await sleep(1400)

ok('重启后仍在阅读栏目', await page.evaluate(() => Boolean(document.body.innerText.includes('译文'))))
ok('重启后译文仍是开着的', (await zhOn()) === true)

const after = await scrollerTop()
ok('滚动位置还原（±40px）', Math.abs(after - before) <= 40, `${before} → ${after}`)

console.log('\n[3] 关译文后再重启：不应残留')
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '译文')
  btn?.click()
})
await sleep(400)
await page.reload({ waitUntil: 'networkidle0' })
await sleep(1200)
ok('关掉后重启仍是关的', (await zhOn()) === false)

await browser.close()
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail > 0 ? 1 : 0)
