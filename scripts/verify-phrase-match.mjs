import puppeteer from 'puppeteer-core'

/**
 * 点词自动匹配固定搭配（±5 词窗口）的浏览器验证。
 *
 * 先 `vite preview --port 5199`，再 `node scripts/verify-phrase-match.mjs`
 *
 * 验四件事：
 *   1. 点短语里的某个词 → 弹层直接给整串（"bunch" → "a bunch of"）
 *   2. 同时给「短语 / 单词」两个视角，能切回单词（用户可能就想查这个词）
 *   3. 短语也能进墨墨（有 id 就显示「加入学习计划」）
 *   4. 不在词典短语里的词 → 不出现切换，仍按单词查（不能把普通句子切碎）
 */

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = process.env.PREVIEW_URL || 'http://localhost:5199/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())

const ARTICLE = {
  id: `${today}#phrase`,
  date: today,
  title: 'Rules and Reasons',
  titleZh: '规则与理由',
  sentences: [
    {
      en: 'The instinct rests on nothing more than a hint of suspicion.',
      zh: '这种本能只建立在一丝猜疑之上。',
    },
    {
      en: 'A bunch of researchers argued that the rule would make sense in practice.',
      zh: '一批研究者认为，这条规则在实践中会是有意义的。',
    },
    {
      en: 'The officer in charge of the unit recorded every deliberate delay.',
      zh: '负责这个单位的官员记录了每一次故意的拖延。',
    },
  ],
  targetWords: [],
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

// 墨墨接口全量 mock：词都"没在学习计划里，但词库里有"
let vocQueryCalls = 0
await page.setRequestInterception(true)
page.on('request', (req) => {
  const url = req.url()
  // web 下走相对路径 /open/api/v1/memo/...，native 下是 open.maimemo.com/open/...，两种都拦
  if (!url.includes('/open/api/v1/memo/') && !url.includes('open.maimemo.com')) return req.continue()

  const json = (body) =>
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: body }) })

  if (url.includes('query_study_records')) return json({ records: [], count: 0 })
  if (url.includes('vocabulary/query')) {
    vocQueryCalls += 1
    // 白名单模拟墨墨真实词库：不是问什么都答"有"
    // 注意：放的是「原形」——墨墨收录的是 rest on，文章里出现的是 rests on，
    // 正好用来验证逐词还原路径（rests on → rest on）
    const KNOWN = new Set(['nothing more than', 'a bunch of', 'in charge of', 'rest on'])
    const asked = JSON.parse(req.postData() ?? '{}').spellings ?? []
    const voc = asked.filter((s) => KNOWN.has(String(s).toLowerCase()))
      .map((s) => ({ id: `voc-${s}`, spelling: s }))
    return json({ voc })
  }
  return json({})
})

await page.goto(APP, { waitUntil: 'networkidle0' })
await page.evaluate((article) => {
  localStorage.clear()
  localStorage.setItem('CapacitorStorage.maimemo_token', 'seed')
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

/** 点正文里的某个词（按钮文本完全匹配） */
const clickWord = async (text) => {
  const hit = await page.evaluate((t) => {
    const btn = [...document.querySelectorAll('[data-sentence] button')].find(
      (b) => b.textContent?.trim() === t && b.dataset.target !== undefined,
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, text)
  await sleep(600)
  return hit
}

const sheetText = () =>
  page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]')
    return dlg ? dlg.innerText.replace(/\s+/g, ' ') : ''
  })

const chipCount = () =>
  page.evaluate(() => document.querySelectorAll('[role="dialog"] button[class*="viewChip"]').length)

const clickChip = (label) =>
  page.evaluate((l) => {
    const btn = [...document.querySelectorAll('[role="dialog"] button[class*="viewChip"]')].find(
      (b) => b.textContent?.trim() === l,
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, label)

console.log('\n[1] 点 "bunch" → 命中 "a bunch of"')
ok('点到了 bunch', await clickWord('bunch'))
let text = await sheetText()
ok('弹层标题是整串短语', text.startsWith('a bunch of'), text.slice(0, 40))
ok('出现「短语 / 单词」切换', (await chipCount()) === 2, await chipCount())
ok('短语也有释义', text.includes('一群') || text.includes('一束') || text.includes('一串'), text.slice(0, 60))
ok('短语可以加入墨墨', text.includes('还没加入墨墨') && text.includes('加入学习计划'), text.slice(0, 80))

console.log('\n[2] 本地词典没有、墨墨有的短语（nothing more than）')
await page.evaluate(() => document.querySelector('[role="dialog"]')?.closest('[class*="mask"]')?.click())
await sleep(400)
ok('点到了 nothing', await clickWord('nothing'))
text = await sheetText()
ok('弹层标题是 nothing more than', text.startsWith('nothing more than'), text.slice(0, 50))
ok('走的是墨墨查询（发起了请求）', vocQueryCalls > 0, vocQueryCalls)
ok('依然可以加入墨墨', text.includes('还没加入墨墨') || text.includes('加入学习计划'), text.slice(0, 90))

console.log('\n[2b] 从短语中间的词也能命中（more）')
await page.evaluate(() => document.querySelector('[role="dialog"]')?.closest('[class*="mask"]')?.click())
await sleep(400)
ok('点到了 more', await clickWord('more'))
text = await sheetText()
ok('仍然匹配到 nothing more than', text.startsWith('nothing more than'), text.slice(0, 50))

console.log('\n[3] 切回单词视角')
// 不按标签找：当前短语不同，词 chip 的字面也跟着变，取"不是『短语』的那个"
const wordChip = await page.evaluate(() => {
  const chips = [...document.querySelectorAll('[role="dialog"] button[class*="viewChip"]')]
  const w = chips.find((b) => b.textContent?.trim() !== '短语')
  if (w) w.click()
  return w ? w.textContent?.trim() : null
})
ok('点词 chip 切回单词', Boolean(wordChip), wordChip)
text = await sheetText()
ok('标题变回那个单词', Boolean(wordChip) && text.startsWith(wordChip), text.slice(0, 40))

console.log('\n[4] 点不带短语的词 → 不出现切换')
await page.evaluate(() => document.querySelector('[role="dialog"]')?.closest('[class*="mask"]')?.click())
await sleep(400)
ok('点到了 deliberate', await clickWord('deliberate'))
text = await sheetText()
ok('标题是单个词', text.startsWith('deliberate'), text.slice(0, 40))
ok('没有「短语」切换（不硬凑）', (await chipCount()) === 0, await chipCount())

console.log('\n[5] 另一处短语：in charge of（本地词典有）')
await page.evaluate(() => document.querySelector('[role="dialog"]')?.closest('[class*="mask"]')?.click())
await sleep(400)
ok('点到了 charge', await clickWord('charge'))
text = await sheetText()
ok('弹层标题是 in charge of', text.startsWith('in charge of'), text.slice(0, 40))

console.log('\n[6] 变形短语还原：点 rests → 命中墨墨里的原形 rest on')
await page.evaluate(() => document.querySelector('[role="dialog"]')?.closest('[class*="mask"]')?.click())
await sleep(400)
ok('点到了 rests', await clickWord('rests'))
text = await sheetText()
ok('弹层标题是还原后的 rest on', text.startsWith('rest on'), text.slice(0, 50))
ok('走的是墨墨查询（发起了请求）', vocQueryCalls > 0, vocQueryCalls)

await browser.close()
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail > 0 ? 1 : 0)
