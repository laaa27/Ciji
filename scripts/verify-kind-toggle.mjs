import puppeteer from 'puppeteer-core'

/**
 * 生成页「类型取消」对多重归属词的保留验证（bug：只看忘记 → 22 个忘记词只剩 1 个）。
 *
 * 场景：4 个未用词，其中 verify 既是忘记又是新学，brace 只有忘记。
 * 先取消「模糊」再取消「新学」：
 *   - 修复前：新学取消时把 verify（忘记∧新学）也删掉 → 已选只剩 brace 1 个
 *   - 修复后：verify 只要还有「忘记」勾着就保留 → 已选 2 个
 * 再点未选中的词，确认能多选。
 *
 * 先 `npx vite preview --port 5199`，再 `node scripts/verify-kind-toggle.mjs`
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

// 4 个未用词；verify 双重归属（忘记∧新学）是本验证的主角
const WORDS = [
  ['verify', ['forget', 'new']],
  ['accelerate', ['vague']],
  ['donation', ['new']],
  ['brace for', ['forget']],
]

const KIND_MAP = { forget: 'FORGET', vague: 'VAGUE', new: 'FAMILIAR' }

const snapshot = {
  date: TODAY,
  finished: WORDS.length,
  total: WORDS.length,
  studyTimeMs: 60_000,
  collectedAt: new Date().toISOString(),
  words: WORDS.map(([spelling, groups], i) => ({
    vocId: `v-${i}`,
    spelling,
    groups,
    isNew: groups.includes('new'),
    firstResponse: KIND_MAP[groups[0]],
    lastResponse: KIND_MAP[groups[0]],
    isFinished: true,
    order: i,
  })),
  rawCount: WORDS.length,
  studiedCount: WORDS.length,
}

// 阅读页要有文章才渲染「生成」入口；这篇文章不含任何目标词，
// 4 个词都算「未用过」
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

/** 点词行（按拼写），返回点击前的按钮状态 */
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
    const count = document.querySelector('span[class*="count"]')?.textContent ?? ''
    const chosenHead = [...document.querySelectorAll('h2')].find((h) =>
      h.textContent?.includes('将使用'),
    )?.textContent ?? ''
    return { count, chosenHead }
  })

console.log('\n[1] 初始：全部类型勾着，4 个词全默认勾上')
let s = await readState()
ok('初始已选 4', s.count.includes('已选 4'), s.count)

console.log('\n[2] 取消「模糊」→ 只删纯模糊词（accelerate），多重归属保留')
ok('点到了模糊', await clickKind('模糊'))
await t(300)
s = await readState()
ok('取消模糊后已选 3', s.count.includes('已选 3'), s.count)

console.log('\n[3] 取消「新学」→ verify（忘记∧新学）必须保留，donation 删掉')
ok('点到了新学', await clickKind('新学'))
await t(300)
s = await readState()
ok('只看忘记时已选 2（verify + brace for）', s.count.includes('已选 2'), s.count)
ok('将使用组含 2 个词', s.chosenHead.includes('2'), s.chosenHead)

console.log('\n[4] 手动点击仍可多选')
ok('点到了 accelerate', await clickWord('accelerate'))
await t(300)
s = await readState()
ok('点词后已选 3（多选正常）', s.count.includes('已选 3'), s.count)

await browser.close()
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail > 0 ? 1 : 0)
