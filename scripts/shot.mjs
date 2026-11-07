import puppeteer from 'puppeteer-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const url = process.argv[2] || 'http://localhost:5173/'
const out = process.argv[3] || 'shot.png'
const tab = process.argv[4]

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
})

const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
await page.goto(url, { waitUntil: 'networkidle0' })

if (tab) {
  const buttons = await page.$$('nav button')
  const idx = ['today', 'history', 'stats', 'settings'].indexOf(tab)
  if (idx >= 0 && buttons[idx]) {
    await buttons[idx].click()
    await new Promise((r) => setTimeout(r, 400))
  }
}

const metrics = await page.evaluate(() => {
  const nav = document.querySelector('nav')
  const tabs = [...document.querySelectorAll('nav button')].map((b) => {
    const r = b.getBoundingClientRect()
    return { text: b.textContent, x: Math.round(r.x), w: Math.round(r.width) }
  })
  return {
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    navWidth: nav ? Math.round(nav.getBoundingClientRect().width) : null,
    tabs,
  }
})

console.log(JSON.stringify(metrics, null, 2))
await page.screenshot({ path: out, fullPage: false })
await browser.close()
