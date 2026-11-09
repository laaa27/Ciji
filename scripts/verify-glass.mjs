import puppeteer from 'puppeteer-core'

/**
 * 液态玻璃底栏的浏览器验证。
 *
 * 先 `npx vite --port 5199`，再 `node scripts/verify-glass.mjs`
 *
 * 覆盖：
 *   1. localStorage 预置开关打开 → 导航栏带 data-glass，backdrop-filter 生效
 *   2. 内容区底部留出了栏的占位（padding-bottom）
 *   3. 开关关闭 → 回到实心栏
 *   4. 设置页开关存在且能即时切换
 */

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5199/'

const t = (ms) => new Promise((r) => setTimeout(r, ms))

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

// ── 1. 预置开关打开 ──────────────────────
await page.goto(URL, { waitUntil: 'networkidle0' })
await page.evaluate(() => {
  localStorage.setItem('CapacitorStorage.liquid_glass', '1')
})
await page.reload({ waitUntil: 'networkidle0' })
await t(600)

let s = await page.evaluate(() => {
  const nav = document.querySelector('nav')
  const cs = getComputedStyle(nav)
  const body = document.querySelector('[data-scroller]')
  return {
    glass: nav.dataset.glass,
    backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
    radius: cs.borderRadius,
    fixed: cs.position,
    bodyPad: getComputedStyle(body).paddingBottom,
  }
})
ok('导航栏 data-glass=true', s.glass === 'true', JSON.stringify(s.glass))
ok('backdrop-filter 生效', String(s.backdrop).includes('blur'), s.backdrop)
ok('胶囊圆角', parseFloat(s.radius) > 100, s.radius)
ok('栏悬浮（fixed）', s.fixed === 'fixed', s.fixed)
ok(
  '内容区留出栏占位',
  parseFloat(s.bodyPad) > 60,
  s.bodyPad,
)

await page.screenshot({ path: 'verify-glass-on.png' })

// ── 2. 设置页开关即时切换 ────────────────
const tabs = await page.$$('nav button')
await tabs[4].click() // 设置
await t(600)
// 0.21 起设置改为分类导航，玻璃开关挪进了「外观」二级页
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(
    (x) => x.textContent?.replace(/\s+/g, '').includes('外观'),
  )
  b?.click()
})
await t(600)
await page.evaluate(() => {
  const label = [...document.querySelectorAll('span')].find((el) =>
    el.textContent?.includes('液态玻璃底栏'),
  )
  label?.closest('label')?.querySelector('input')?.click()
})
await t(500)

s = await page.evaluate(() => {
  const nav = document.querySelector('nav')
  return {
    glass: nav.dataset.glass,
    stored: localStorage.getItem('CapacitorStorage.liquid_glass'),
  }
})
ok('设置页关闭后即时生效', s.glass === 'false', JSON.stringify(s.glass))
ok('开关状态落盘', s.stored === '0', s.stored)

await page.screenshot({ path: 'verify-glass-off.png' })

console.log(`\n结果：${pass} 过，${fail} 挂`)
await browser.close()
process.exit(fail > 0 ? 1 : 0)
