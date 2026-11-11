import puppeteer from 'puppeteer-core'

/**
 * 释义来源标记（「AI 释义」标签）的浏览器验证。
 *
 * 先 `npm run build` + `vite preview --port 5199`，再 `node tests/e2e/verify-gloss-source.mjs`
 *
 * 验的是「同一个词查第二次，标签不许丢」：
 *   1. 首次查询走 AI → 有标注
 *   2. 同一会话再点一次（内存缓存）→ 仍有标注，且不再调模型
 *   3. 重载页面后再点（Preferences 缓存，这就是缺陷现场）→ 仍有标注，仍不再调模型
 *   4. 本地词典命中的词 → 不标 AI
 *   5. MyMemory 兜底写入的缓存 → 不标 AI（别把机器翻译也算成 AI 释义）
 *   6. 修复前写入的纯文本缓存条目 → 仍能读，按非 AI 处理
 *
 * 用词 zorbix / blorft / quibblesome 都是虚构词，已确认不在 public/dict 里。
 */

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = process.env.PREVIEW_URL || 'http://localhost:5199/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const AI_GLOSS = 'n. 模拟装置；测试用虚构物'
const ONLINE_GLOSS = 'n. 虚构的斑点'
const LEGACY_GLOSS = 'n. 旧格式缓存释义'

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())

const ARTICLE = {
  id: `${today}#glosssource`,
  date: today,
  title: 'A Quiet Desk',
  titleZh: '安静的桌子',
  sentences: [
    { en: 'The zorbix hummed quietly on the desk.', zh: '那个 zorbix 在桌上安静地响着。' },
    { en: 'A blorft appeared near the window.', zh: '窗边出现了一个 blorft。' },
    { en: 'Every quibblesome detail was recorded.', zh: '每个 quibblesome 的细节都被记录下来了。' },
    { en: 'The officer recorded every deliberate delay.', zh: '官员记录了每一次故意的拖延。' },
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

// 模型与在线翻译都 mock：AI 只认得 zorbix，其余词让它落到 MyMemory
let llmCalls = 0
let myMemoryCalls = 0
await page.setRequestInterception(true)
page.on('request', (req) => {
  const url = req.url()

  const json = (body) =>
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

  // web 下大模型走 vite 中间件 /__llm?url=...（preview 没有该路由，正好由这里接管）
  if (url.includes('/__llm')) {
    llmCalls += 1
    let asked = []
    try {
      const body = JSON.parse(req.postData() ?? '{}')
      asked = JSON.parse(body.messages.at(-1)?.content ?? '[]')
    } catch {
      asked = []
    }
    const glosses = {}
    if (asked.includes('zorbix')) glosses.zorbix = AI_GLOSS
    return json({
      choices: [{ message: { content: JSON.stringify(glosses) }, finish_reason: 'stop' }],
    })
  }

  if (url.includes('api.mymemory.translated.net')) {
    myMemoryCalls += 1
    // 跨域请求必须带 ACAO，否则页面里的 fetch 会被浏览器拦掉，测的就不是我们的代码了
    return req.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ responseData: { translatedText: ONLINE_GLOSS } }),
    })
  }

  if (!url.includes('/open/api/v1/memo/') && !url.includes('open.maimemo.com')) return req.continue()

  if (url.includes('query_study_records')) return json({ success: true, data: { records: [], count: 0 } })
  if (url.includes('vocabulary/query')) return json({ success: true, data: { voc: [] } })
  return json({ success: true, data: {} })
})

await page.goto(APP, { waitUntil: 'networkidle0' })
await page.evaluate(
  ({ article, legacyGloss }) => {
    localStorage.clear()
    localStorage.setItem('CapacitorStorage.maimemo_token', 'seed')
    localStorage.setItem('CapacitorStorage.article:' + article.id, JSON.stringify(article))
    localStorage.setItem(
      'CapacitorStorage.article_index',
      JSON.stringify([{ id: article.id, date: article.date, title: article.title }]),
    )
    // 一个可用的模型配置：没有它，AI 释义层直接被跳过
    localStorage.setItem(
      'CapacitorStorage.llm_profiles',
      JSON.stringify([
        {
          id: 'p1',
          name: 'mock',
          protocol: 'openai',
          baseUrl: 'https://mock.local/v1',
          apiKey: 'k',
          model: 'mock-model',
          createdAt: new Date().toISOString(),
        },
      ]),
    )
    localStorage.setItem('CapacitorStorage.llm_active', 'p1')
    // 模拟修复前写入的纯文本缓存（没有来源信息）
    localStorage.setItem('CapacitorStorage.gloss:quibblesome', legacyGloss)
  },
  { article: ARTICLE, legacyGloss: LEGACY_GLOSS },
)
await page.reload({ waitUntil: 'networkidle0' })
await sleep(600)

/** 进阅读页 */
const openReading = async () => {
  const tabs = await page.$$('nav button')
  await tabs[2].click()
  await sleep(900)
}

const clickWord = async (text) => {
  const hit = await page.evaluate((t) => {
    const btn = [...document.querySelectorAll('[data-sentence] button')].find(
      (b) => b.textContent?.trim() === t && b.dataset.target !== undefined,
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, text)
  await sleep(900)
  return hit
}

const sheetText = () =>
  page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]')
    return dlg ? dlg.innerText.replace(/\s+/g, ' ') : ''
  })

const closeSheet = async () => {
  await page.evaluate(() => document.querySelector('[role="dialog"]')?.closest('[class*="mask"]')?.click())
  await sleep(400)
}

/** 读缓存原始值：新格式是 JSON，旧格式是纯文本 */
const cacheOf = (word) =>
  page.evaluate((w) => {
    const raw = localStorage.getItem('CapacitorStorage.gloss:' + w)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return { legacy: raw }
    }
  }, word)

await openReading()

console.log('\n[1] 首次查询：本地没有 → AI 释义')
ok('点到了 zorbix', await clickWord('zorbix'))
let text = await sheetText()
ok('弹层有 AI 给的释义', text.includes(AI_GLOSS), text.slice(0, 80))
ok('标了「AI 释义」', text.includes('AI 释义'), text.slice(0, 80))
let cache = await cacheOf('zorbix')
ok('缓存里存了释义 + 来源', cache?.gloss === AI_GLOSS && cache?.ai === true, JSON.stringify(cache))
const llmAfterFirst = llmCalls
ok('确实调了模型', llmAfterFirst >= 1, llmAfterFirst)

console.log('\n[2] 同一会话再点一次（内存缓存）')
await closeSheet()
ok('点到了 zorbix', await clickWord('zorbix'))
text = await sheetText()
ok('释义仍是 AI 那条', text.includes(AI_GLOSS), text.slice(0, 80))
ok('「AI 释义」还在', text.includes('AI 释义'), text.slice(0, 80))
ok('没有重复调模型', llmCalls === llmAfterFirst, `${llmAfterFirst} → ${llmCalls}`)

console.log('\n[3] 重载页面后再点（Preferences 缓存命中，缺陷现场）')
await page.reload({ waitUntil: 'networkidle0' })
await sleep(600)
await openReading()
ok('点到了 zorbix', await clickWord('zorbix'))
text = await sheetText()
ok('释义从本地读出来了', text.includes(AI_GLOSS), text.slice(0, 80))
ok('「AI 释义」没有丢', text.includes('AI 释义'), text.slice(0, 80))
ok('依旧没有重复调模型', llmCalls === llmAfterFirst, `${llmAfterFirst} → ${llmCalls}`)

console.log('\n[4] 本地词典命中的词：不标 AI')
await closeSheet()
ok('点到了 deliberate', await clickWord('deliberate'))
text = await sheetText()
ok('本地词典有释义', text.length > 'deliberate 关闭'.length, text.slice(0, 80))
ok('没有「AI 释义」标记', !text.includes('AI 释义'), text.slice(0, 80))
ok('也没有写进释义缓存', (await cacheOf('deliberate')) === null, JSON.stringify(await cacheOf('deliberate')))

console.log('\n[5] AI 没给结果的词 → MyMemory 兜底，同样不标 AI')
await closeSheet()
ok('点到了 blorft', await clickWord('blorft'))
text = await sheetText()
ok('拿到 MyMemory 的释义', text.includes(ONLINE_GLOSS), text.slice(0, 80))
ok('没有「AI 释义」标记', !text.includes('AI 释义'), text.slice(0, 80))
cache = await cacheOf('blorft')
ok('缓存记的是非 AI 来源', cache?.gloss === ONLINE_GLOSS && cache?.ai === false, JSON.stringify(cache))

console.log('\n[6] 修复前写入的纯文本缓存：能读出来，且按非 AI 处理')
await closeSheet()
ok('点到了 quibblesome', await clickWord('quibblesome'))
text = await sheetText()
ok('旧条目的释义照常显示', text.includes(LEGACY_GLOSS), text.slice(0, 80))
ok('不冒充 AI 释义', !text.includes('AI 释义'), text.slice(0, 80))

await browser.close()
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail > 0 ? 1 : 0)
