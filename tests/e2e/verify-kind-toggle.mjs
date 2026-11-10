import puppeteer from 'puppeteer-core'

/**
 * 生成页「三类互斥」+「类型取消」+「多选」的浏览器验证（0.23.0）。
 *
 * 数据背景（2026-11-10 用户要求）：新学词只算「新学」，哪怕今天答了忘记——
 * 忘记 / 模糊只收复习词。词库里 verify 被标了忘记，但它今天新学 → 只出现在「新学」。
 *
 * 场景 4 个词：
 *   verify     isNew=true,  groups=['forget','new']（老快照残留多归属 → 应掰正为只算新学）
 *   accelerate isNew=false, groups=['vague']
 *   donation   isNew=true,  groups=['new']
 *   brace for  isNew=false, groups=['forget']
 *
 * 验证：
 *   [1] 初始全选 4；verify 的徽标只有「新学」；忘记组计数只有 brace for 一个
 *   [2] 取消模糊 → 已选 3
 *   [3] 取消新学 → 已选 1（brace for；verify 因为只算新学被撤掉）
 *   [4] 点 verify → 已选 2（多选正常）
 *
 * 先 `npx vite preview --port 5199`，再 `node tests/e2e/verify-kind-toggle.mjs`
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

const WORDS = [
  { spelling: 'verify', groups: ['forget', 'new'], isNew: true },
  { spelling: 'accelerate', groups: ['vague'], isNew: false },
  { spelling: 'donation', groups: ['new'], isNew: true },
  { spelling: 'brace for', groups: ['forget'], isNew: false },
]

const KIND_MAP = { forget: 'FORGET', vague: 'VAGUE', new: 'FAMILIAR' }

const snapshot = {
  date: TODAY,
  finished: WORDS.length,
  total: WORDS.length,
  studyTimeMs: 60_000,
  collectedAt: new Date().toISOString(),
  words: WORDS.map((w, i) => ({
    vocId: `v-${i}`,
    spelling: w.spelling,
    groups: w.groups,
    isNew: w.isNew,
    firstResponse: KIND_MAP[w.isNew ? 'new' : w.groups[0]] ?? 'FAMILIAR',
    lastResponse: KIND_MAP[w.isNew ? 'new' : w.groups[0]] ?? 'FAMILIAR',
    isFinished: true,
    order: i,
  })),
  rawCount: WORDS.length,
  studiedCount: WORDS.length,
}

// 阅读页要有文章才渲染「生成」入口；这篇文章不含任何目标词，4 个词都算「未用过」
const article = {
  id: TODAY + '#kind',
  date: TODAY,
  title: 'Placeholder',
  titleZh: '占位',
  sentences: [
    { en: 'Time and tide wait for no man.', zh: '时光不等人。' },
  ],
  targetWords: [],
  mode: 'weak',
  level: 'cet4',
  model: 'seed',
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
await page.evaluate((snap, art) => {
  localStorage.clear()
  localStorage.setItem('CapacitorStorage.day:' + snap.date, JSON.stringify(snap))
  localStorage.setItem('CapacitorStorage.article:' + art.id, JSON.stringify(art))
  localStorage.setItem(
    'CapacitorStorage.article_index',
    JSON.stringify([{ id: art.id, date: art.date, title: art.title }]),
  )
  // 旧版键：启动迁移成一份模型配置，否则阅读页被「未配置大模型」门挡住，生成入口不出现
  localStorage.setItem('CapacitorStorage.llm_key', 'seed-key-for-kind-toggle')
}, snapshot, article)
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

/** 点类型按钮（按标签找，如「模糊」「新学」） */
const clickKind = (label) =>
  page.evaluate((l) => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.querySelector('span[class*="tick"]') && b.textContent?.trim().startsWith(l),
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, label)

/** 点词行（按拼写） */
const clickWord = (spelling) =>
  page.evaluate((s) => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.querySelector('span[class*="spelling"]')?.textContent?.trim() === s,
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, spelling)

const readState = () =>
  page.evaluate(() => {
    const count = document.querySelector('header [class*="count"]')?.textContent ?? ''
    const wordRow = (s) => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        b.querySelector('span[class*="spelling"]')?.textContent?.trim() === s,
      )
      return btn ? btn.textContent?.replace(/\s+/g, ' ').trim() : ''
    }
    return { count, verifyRow: wordRow('verify') }
  })

console.log('\n[1] 三类互斥：verify（新学∧今天答忘记）只算新学')
let s = await readState()
ok('初始已选 4', s.count.includes('已选 4'), s.count)
ok('verify 徽标只有新学', s.verifyRow.includes('新学') && !s.verifyRow.includes('忘记'), s.verifyRow)

console.log('\n[2] 取消模糊 → 已选 3')
ok('点到了模糊', await clickKind('模糊'))
await t(300)
s = await readState()
ok('取消模糊后已选 3', s.count.includes('已选 3'), s.count)

console.log('\n[3] 取消新学 → verify/donation 撤掉，只剩 brace for')
ok('点到了新学', await clickKind('新学'))
await t(300)
s = await readState()
ok('只看忘记时已选 1', s.count.includes('已选 1'), s.count)

console.log('\n[4] 手动点击仍可多选（verify 算新学，可点回）')
ok('点到了 verify', await clickWord('verify'))
await t(300)
s = await readState()
ok('点 verify 后已选 2', s.count.includes('已选 2'), s.count)

await browser.close()
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail > 0 ? 1 : 0)
