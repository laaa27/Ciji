import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

/**
 * 导入功能的浏览器冒烟测试（无需真机、无需 token）。
 *
 * 覆盖的真机路径：
 *   选择文件 → 解析 → 预览（几天 / 几个词 / 冲突天） → 两种合并策略 → 写 localStorage
 *
 * 用法：先 `npx vite --port 5199`，再 `node scripts/test-import.mjs`
 */

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = process.env.PREVIEW_URL || 'http://localhost:5199/'
const OUT = process.argv[2] || 'import-check.png'

const day = (date, words) => ({
  date,
  finished: words.length,
  total: words.length + 4,
  studyTimeMs: words.length * 15_000,
  words: words.map((w, i) => ({
    vocId: `${date}-${i}`,
    spelling: w[0],
    groups: w[1],
    isNew: w[1].includes('new'),
    firstResponse: w[2] ?? 'FAMILIAR',
    lastResponse: w[2] ?? 'FAMILIAR',
    isFinished: true,
    order: i,
  })),
  collectedAt: `${date}T10:00:00.000Z`,
  rawCount: words.length,
  studiedCount: words.length,
})

const LOCAL_DAYS = [
  day('2026-11-05', [['abandon', ['new'], 'FAMILIAR'], ['scrutiny', ['forget'], 'FORGET']]),
  day('2026-11-06', [['coherent', ['vague'], 'VAGUE']]),
]

// 备份文件：2 天与本地重叠（11-05/11-06 之外再加两天全新）
const BACKUP_DAYS = [
  day('2026-11-03', [['eloquent', ['new', 'vague'], 'VAGUE'], ['give up', ['forget'], 'FORGET']]),
  day('2026-11-04', [['implicit', ['new'], 'FAMILIAR']]),
  day('2026-11-05', [['abandon', ['new', 'forget'], 'FORGET']]),
]

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciji-import-'))
const backupPath = path.join(tmp, '词迹备份-2026-11-07.json')
fs.writeFileSync(
  backupPath,
  JSON.stringify(
    { format: 'ciji-backup', version: 1, app: '词迹', exportedAt: new Date().toISOString(), count: BACKUP_DAYS.length, days: BACKUP_DAYS },
    null,
    2,
  ),
  'utf8',
)

const csvPath = path.join(tmp, '词迹-2026-11-07.csv')
fs.writeFileSync(
  csvPath,
  '日期,单词,类型,释义\n' +
    '2026-11-07,scrutiny,"新学/忘记","n. 详细审查"\n' +
    '2026-11-07,give up,模糊,放弃\n' +
    '2026-11-08,"in terms of",新学,就\n',
  'utf8',
)

let pass = 0
let fail = 0
function ok(name, cond, extra) {
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

const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  // 静态资源 404（favicon 之类）不算代码报错
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
})

await page.goto(URL, { waitUntil: 'networkidle0' })

// 造本地已有数据
await page.evaluate((days) => {
  localStorage.clear()
  for (const d of days) {
    localStorage.setItem('CapacitorStorage.day:' + d.date, JSON.stringify(d))
  }
}, LOCAL_DAYS)
await page.reload({ waitUntil: 'networkidle0' })

const readStore = () =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('CapacitorStorage.day:'))
      .sort()
      .map((k) => {
        const v = JSON.parse(localStorage.getItem(k))
        return { date: v.date, words: v.words.length, first: v.words[0]?.spelling }
      }),
  )

// 进入设置页
const tabs = await page.$$('nav button')
await tabs[4].click()
await new Promise((r) => setTimeout(r, 500))

const clickByText = (text) =>
  page.evaluate((t) => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.replace(/\s+/g, '').includes(t),
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, text)

const visibleText = () =>
  page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))

console.log('\n[1] 选择备份 JSON → 预览')
const fileInputs = await page.$$('input[type=file]')
ok('存在文件输入', fileInputs.length === 1, fileInputs.length)
await fileInputs[0].uploadFile(backupPath)
await new Promise((r) => setTimeout(r, 600))

const text1 = await visibleText()
ok('显示文件名', text1.includes('词迹备份-2026-11-07.json'), text1.slice(0, 200))
ok('显示天数与词数', text1.includes('3 天') && text1.includes('4 个词'), text1.match(/备份 ·[^。]{0,40}/)?.[0])
ok('提示冲突 1 天', text1.includes('其中 1 天本地已有记录'))
ok('提供仅补 / 覆盖两个按钮', text1.includes('仅补 2 天') && text1.includes('覆盖 1 天'))
await page.evaluate(() => {
  const el = [...document.querySelectorAll('p')].find((p) =>
    p.textContent?.includes('本地已有记录'),
  )
  el?.scrollIntoView({ block: 'center' })
})
await new Promise((r) => setTimeout(r, 400))
await page.screenshot({ path: OUT, fullPage: false })

console.log('\n[2] 仅补缺失 → 本地已有不动')
await clickByText('仅补2天')
await new Promise((r) => setTimeout(r, 600))
let store = await readStore()
ok('写入后共 4 天', store.length === 4, store.map((s) => s.date))
ok('11-05 未被覆盖', store.find((s) => s.date === '2026-11-05').words === 2, store)
const text2 = await visibleText()
ok('提示新增 2 天', text2.includes('导入完成：新增 2 天'), text2.match(/导入完成[^取]{0,40}/)?.[0])
ok('预览卡片消失', !text2.includes('其中 1 天本地已有记录'))

console.log('\n[3] 同一文件再选一次 → 没有可写，给出警告')
await (await page.$$('input[type=file]'))[0].uploadFile(backupPath)
await new Promise((r) => setTimeout(r, 500))
const text3 = await visibleText()
ok('冲突变 3 天', text3.includes('其中 3 天本地已有记录'))
ok('没有「仅补」按钮', !text3.includes('仅补 0 天'))

console.log('\n[4] 覆盖策略 → 同日期以文件为准')
await clickByText('覆盖3天')
await new Promise((r) => setTimeout(r, 600))
store = await readStore()
ok('仍是 4 天', store.length === 4, store.map((s) => s.date))
ok('11-05 被覆盖为文件里的 1 个词', store.find((s) => s.date === '2026-11-05').words === 1, store)
ok('文件里没有的 11-06 保留（不做删除）', store.some((s) => s.date === '2026-11-06'), store.map((s) => s.date))
ok('提示覆盖 3 天', (await visibleText()).includes('覆盖 3 天'))

console.log('\n[5] 导入 CSV')
await (await page.$$('input[type=file]'))[0].uploadFile(csvPath)
await new Promise((r) => setTimeout(r, 600))
const text5 = await visibleText()
ok('识别为 CSV', text5.includes('CSV · 2 天 · 3 个词'), text5.match(/CSV ·[^。]{0,30}/)?.[0])
await clickByText('导入2天')
await new Promise((r) => setTimeout(r, 600))
store = await readStore()
ok('变成 6 天', store.length === 6, store.map((s) => s.date))
ok('CSV 的短语入库', store.some((s) => s.date === '2026-11-08'))
ok('提示新增 2 天', (await visibleText()).includes('导入完成：新增 2 天'))

console.log('\n[6] 坏文件不崩')
const badPath = path.join(tmp, 'bad.json')
fs.writeFileSync(badPath, '{"oops"', 'utf8')
await (await page.$$('input[type=file]'))[0].uploadFile(badPath)
await new Promise((r) => setTimeout(r, 500))
ok('给出格式错误提示', /不是合法 JSON|无法识别/.test(await visibleText()))
ok('页面无 JS 报错', errors.length === 0, errors.slice(0, 2))

await page.screenshot({ path: OUT.replace('.png', '-after.png') })
console.log(`\n通过 ${pass} / 失败 ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
