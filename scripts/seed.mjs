import puppeteer from 'puppeteer-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5173/'

const POOL = [
  // 放最前，保证第一天就出现在列表里，用来验证在线兜底链路
  'give up', 'in terms of', 'take into account',
  'abandon', 'inherent', 'scrutiny', 'prevalent', 'concede', 'eloquent',
  'reluctant', 'ambiguous', 'coherent', 'implicit', 'notorious', 'vulnerable',
  'meticulous', 'pragmatic', 'tentative', 'obscure', 'resilient', 'candid',
  'dubious', 'feasible', 'intricate', 'lucid', 'novel', 'profound',
]

function dateKey(offset) {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

function wave(offset, base, amp, period) {
  return Math.max(0, Math.round(base + amp * Math.sin(offset / period)))
}

function makeDay(offset) {
  const nNew = wave(offset, 9, 5, 3.1)
  const nVague = wave(offset, 3, 2.5, 2.3)
  const nForget = wave(offset, 2, 1.8, 4.7)
  const words = []
  let i = 0

  const push = (state, count, first, last) => {
    for (let k = 0; k < count; k += 1) {
      const spelling = POOL[(offset * 7 + i * 3) % POOL.length]
      i += 1
      words.push({
        vocId: `${offset}-${i}`,
        spelling,
        groups: [state],
        isNew: state === 'new',
        isFinished: true,
        order: i,
        firstResponse: first,
        lastResponse: last,
      })
    }
  }

  push('new', nNew, 'FAMILIAR', 'FAMILIAR')
  push('vague', nVague, 'VAGUE', offset % 3 === 0 ? 'FAMILIAR' : 'VAGUE')
  push('forget', nForget, 'FORGET', offset % 2 === 0 ? 'VAGUE' : 'FORGET')

  return {
    date: dateKey(offset),
    finished: words.length,
    total: words.length + wave(offset, 8, 4, 5),
    studyTimeMs: words.length * 18_000,
    collectedAt: new Date().toISOString(),
    words,
    rawCount: words.length,
    studiedCount: words.length,
  }
}

const days = Array.from({ length: 30 }, (_, i) => makeDay(i))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
})

const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
await page.goto(URL, { waitUntil: 'networkidle0' })

await page.evaluate((payload) => {
  for (const d of payload) {
    localStorage.setItem('CapacitorStorage.day:' + d.date, JSON.stringify(d))
  }
}, days)

await page.reload({ waitUntil: 'networkidle0' })

const tabs = await page.$$('nav button')
const which = process.argv[3] || 'history'
const idx = { today: 0, history: 1, stats: 2, settings: 3 }[which] ?? 1
if (tabs[idx]) await tabs[idx].click()
await new Promise((r) => setTimeout(r, 700))

if (which === 'history') {
  const firstHead = await page.$('ul li button')
  if (firstHead) await firstHead.click()
  // 只等本地分片加载，在线兜底应该后补、不阻塞本地释义
  await new Promise((r) => setTimeout(r, 1200))
}

await page.screenshot({ path: process.argv[2] || 'history.png' })
console.log('seeded', days.length, 'days, tab =', which)
await browser.close()
