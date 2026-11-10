import puppeteer from 'puppeteer-core'

/**
 * 今日页吸顶 + 主题切换过渡的浏览器验证。
 * 先 `npx vite --port 5199`，再 `node tests/e2e/test-sticky.mjs`
 */

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP = process.env.PREVIEW_URL || 'http://localhost:5199/'

let pass = 0
let fail = 0
const ok = (n, c, e) => {
  if (c) {
    pass += 1
    console.log('  ✓', n)
  } else {
    fail += 1
    console.log('  ✗', n, e ?? '')
  }
}

const POOL = [
  'abandon', 'scrutiny', 'coherent', 'give up', 'eloquent', 'prevalent', 'concede',
  'reluctant', 'ambiguous', 'implicit', 'notorious', 'vulnerable', 'meticulous',
  'pragmatic', 'tentative', 'obscure', 'resilient', 'candid', 'dubious', 'feasible',
  'intricate', 'lucid', 'novel', 'profound', 'inherent', 'austere', 'benevolent',
]
const stateOf = { new: 'FAMILIAR', vague: 'VAGUE', forget: 'FORGET' }
const todayItems = []
for (const [state, count] of [['new', 25], ['vague', 10], ['forget', 8]]) {
  for (let i = 0; i < count; i += 1) {
    todayItems.push({
      voc_id: `${state}-${i}`,
      voc_spelling: POOL[(todayItems.length + 3) % POOL.length],
      first_response: stateOf[state],
      is_new: state === 'new',
      is_finished: true,
      order: todayItems.length,
    })
  }
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
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
})

await page.setRequestInterception(true)
page.on('request', (req) => {
  const url = req.url()
  if (!url.includes('/open/')) return req.continue()
  const json = (body) =>
    req.respond({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: body }),
    })
  if (url.includes('get_study_progress')) return json({ progress: { finished: 43, total: 50, study_time: 1500000 } })
  if (url.includes('get_today_items')) return json({ today_items: todayItems })
  if (url.includes('query_study_records')) return json({ records: [], count: 0 })
  return req.continue()
})

const t = (ms) => new Promise((r) => setTimeout(r, ms))

await page.goto(APP, { waitUntil: 'networkidle0' })
await page.evaluate(() => localStorage.setItem('CapacitorStorage.maimemo_token', 'seed-token'))
await page.reload({ waitUntil: 'networkidle0' })
await t(1200)

const heads = () =>
  page.evaluate(() => {
    const out = {}
    for (const el of document.querySelectorAll('[data-group-head]')) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      out[el.dataset.groupHead] = {
        top: Math.round(r.top * 10) / 10,
        stuck: el.dataset.stuck,
        position: cs.position,
        bg: cs.backgroundColor,
        shadow: cs.boxShadow,
      }
    }
    return out
  })

const scrollTo = async (y) => {
  await page.evaluate((target) => {
    const scroller = [...document.querySelectorAll('div')].find(
      (d) => d.scrollHeight > d.clientHeight + 100,
    )
    scroller.scrollTop = target
  }, y)
  await t(200)
}

console.log('\n[1] sticky 生效')
let h = await heads()
ok('三个分组头都在', Object.keys(h).length === 3, Object.keys(h))
ok('position 是 sticky', h.new.position === 'sticky', h.new.position)
ok('未滚动时不算悬浮', h.new.stuck === 'false', h.new.stuck)
ok('未悬浮时没有横线', h.new.shadow === 'none', h.new.shadow)

await scrollTo(600)
h = await heads()
ok('滚动后第一个标题贴住顶部', Math.abs(h.new.top - 30) <= 1.5, h.new.top)
ok('贴住后标记为 stuck', h.new.stuck === 'true', h.new.stuck)
ok('贴住后出现细线', h.new.shadow !== 'none', h.new.shadow)
ok('底色是纸色（不透明，词不穿透）', h.new.bg !== 'rgba(0, 0, 0, 0)', h.new.bg)

console.log('\n[2] 下一个标题把它顶走')
// 滚到模糊组开始的位置
const vagueStart = await page.evaluate(() => {
  const el = document.querySelector('[data-group-head="vague"]')
  const scroller = [...document.querySelectorAll('div')].find(
    (d) => d.scrollHeight > d.clientHeight + 100,
  )
  return scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
})
await scrollTo(vagueStart + 40)
h = await heads()
ok('模糊标题吸住', Math.abs(h.vague.top - 30) <= 1.5, h.vague.top)
ok('新学标题被顶到上方（看不见的位置）', h.new.top < 20, h.new.top)
ok('新学不再标记 stuck', h.new.stuck === 'false', h.new.stuck)

console.log('\n[3] 主题切换过渡')
const hasVT = await page.evaluate(() => typeof document.startViewTransition === 'function')
ok('WebView 支持 View Transitions', hasVT)

const tabs = await page.$$('nav button')
await tabs[4].click()
await t(400)

// 0.21 起设置改为分类导航，主题开关挪进了「外观」二级页
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(
    (x) => x.textContent?.replace(/\s+/g, '').includes('外观'),
  )
  b?.click()
})
await t(500)

// 记录 startViewTransition 是否被调用；getAnimations() 拿不到伪元素上的过渡动画，
// 所以改用「过渡中途的那一帧是否与终态不同」来证明真的在混合
await page.evaluate(() => {
  window.__vt = 0
  const orig = document.startViewTransition.bind(document)
  document.startViewTransition = (cb) => {
    window.__vt += 1
    return orig(cb)
  }
})

const before = await page.screenshot({ encoding: 'base64' })
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '深夜')
  b?.click()
})
await t(110)
const mid = await page.screenshot({ encoding: 'base64' })
await t(450)
const steady = await page.screenshot({ encoding: 'base64' })
const vtCalls = await page.evaluate(() => window.__vt)
ok('走了 View Transitions 路径', vtCalls === 1, vtCalls)
ok('中途帧与终态不同（说明确实在淡入淡出）', mid !== steady)
ok('中途帧与起始帧不同', mid !== before)
const after = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.body).backgroundColor,
}))
ok('切换后是深夜', after.theme === 'dark', after.theme)
ok('背景变深', after.bg === 'rgb(18, 20, 19)', after.bg)

await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '白天')
  b?.click()
})
await t(500)
const back = await page.evaluate(() => document.documentElement.dataset.theme)
ok('能切回白天', back === 'light', back)

console.log('\n[4] 无 JS 报错')
ok('页面干净', errors.length === 0, errors.slice(0, 3))

console.log(`\n通过 ${pass} / 失败 ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
