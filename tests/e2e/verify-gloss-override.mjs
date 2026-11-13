import puppeteer from 'puppeteer-core'

/**
 * 词卡里的备选释义：AI 释义 + 自定义释义（与主释义并存）。
 *
 * 三条规则：
 *   1. 主释义永远显示；AI / 自定义各占一行，**有内容才出现**，没有就给入口按钮
 *   2. 主释义本身就是 AI 给的（本地没收录、AI 兜底生成）时，不再单开一行，
 *      入口改成「重新生成」—— 否则会和上面一字不差
 *   3. 主释义查不到时，自定义释义兜底顶上（并标「自定义」）
 *
 * 只影响词卡：今日/历史词表仍然只显示主释义（所以这里不验词表）。
 *
 * 先 `npm run build` + `vite preview --port 5199`，再
 *   node tests/e2e/verify-gloss-override.mjs
 */

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = process.env.PREVIEW_URL || 'http://localhost:5199/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const AI_FILING = 'n. AI 版：归档；提交'
const AI_ZORBIX = 'n. 虚构的响器'
const MY_CUSTOM = 'n. 我自己记的：锉屑那种碎末'

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())

const ARTICLE = {
  id: `${today}#altgloss`,
  date: today,
  title: 'The Filing Room',
  titleZh: '档案室',
  sentences: [
    { en: 'Every official filing was stored in the room.', zh: '每份正式归档都存放于该室。' },
    { en: 'A zorbix hummed beside the cabinet.', zh: '柜子旁有个 zorbix 在响。' },
    { en: 'Nobody could read the quibblex notes.', zh: '没人看得懂那些 quibblex 笔记。' },
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

const errors = []
page.on('pageerror', (e) => errors.push(e.message))

let llmCalls = 0
await page.setRequestInterception(true)
page.on('request', (req) => {
  const url = req.url()
  const json = (body, headers = {}) =>
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers })

  if (url.includes('/__llm')) {
    llmCalls += 1
    let asked = []
    try {
      asked = JSON.parse(JSON.parse(req.postData() ?? '{}').messages.at(-1)?.content ?? '[]')
    } catch {
      asked = []
    }
    const glosses = {}
    if (asked.includes('filing')) glosses.filing = AI_FILING
    if (asked.includes('zorbix')) glosses.zorbix = AI_ZORBIX
    // quibblex 故意不返回：模拟「模型也答不上来」
    return json({ choices: [{ message: { content: JSON.stringify(glosses) }, finish_reason: 'stop' }] })
  }

  if (url.includes('api.mymemory.translated.net')) {
    const q = new URL(url).searchParams.get('q') ?? ''
    return json(
      { responseData: { translatedText: q === 'quibblex' ? '' : 'n. 机器翻译结果' } },
      { 'Access-Control-Allow-Origin': '*' },
    )
  }

  if (!url.includes('/open/api/v1/memo/') && !url.includes('open.maimemo.com')) return req.continue()
  if (url.includes('query_study_records')) return json({ success: true, data: { records: [], count: 0 } })
  if (url.includes('vocabulary/query')) return json({ success: true, data: { voc: [] } })
  return json({ success: true, data: {} })
})

await page.goto(APP, { waitUntil: 'networkidle0' })
await page.evaluate(({ article, custom }) => {
  localStorage.clear()
  localStorage.setItem('CapacitorStorage.maimemo_token', 'seed')
  localStorage.setItem('CapacitorStorage.article:' + article.id, JSON.stringify(article))
  localStorage.setItem(
    'CapacitorStorage.article_index',
    JSON.stringify([{ id: article.id, date: article.date, title: article.title }]),
  )
  localStorage.setItem(
    'CapacitorStorage.llm_profiles',
    JSON.stringify([
      {
        id: 'p1', name: 'mock', protocol: 'openai', baseUrl: 'https://mock.local/v1',
        apiKey: 'k', model: 'mock-model', createdAt: new Date().toISOString(),
      },
    ]),
  )
  localStorage.setItem('CapacitorStorage.llm_active', 'p1')
  // 主释义查不到、但用户早就写过释义的词 —— 验「自定义兜底」
  localStorage.setItem('CapacitorStorage.gloss_alt:quibblex', JSON.stringify({ custom }))
}, { article: ARTICLE, custom: MY_CUSTOM })
await page.reload({ waitUntil: 'networkidle0' })
await sleep(600)

const openReading = async () => {
  const tabs = await page.$$('nav button')
  await tabs[2].click()
  await sleep(900)
}
/**
 * 点正文里的词。
 * 点词可能匹配到固定搭配（例如 filing 落在 "official file" 的窗口里），
 * 那时弹层默认开在「短语」视图 —— 这里再点一下同名词片，切回单词视图。
 */
const clickWord = async (text) => {
  const hit = await page.evaluate((t) => {
    const btn = [...document.querySelectorAll('[data-sentence] button')].find(
      (b) => b.textContent?.trim() === t && b.dataset.target !== undefined,
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, text)
  await sleep(1100)
  if (!hit) return false

  await page.evaluate((t) => {
    const chip = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === t && !b.dataset.testid,
    )
    chip?.click()
  }, text)
  await sleep(700)
  return true
}
const closeSheet = async () => {
  await page.evaluate(() =>
    document.querySelector('[role="dialog"]')?.closest('[class*="mask"]')?.click(),
  )
  await sleep(400)
}
const has = (testid) => page.evaluate((id) => Boolean(document.querySelector(`[data-testid="${id}"]`)), testid)
const textOf = (testid) =>
  page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? '', testid)
const clickTestId = async (testid) => {
  await page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.click(), testid)
  await sleep(600)
}
const sheetText = () =>
  page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]')
    return dlg ? dlg.innerText.replace(/\s+/g, ' ') : ''
  })
const altOf = (word) =>
  page.evaluate((w) => {
    const raw = localStorage.getItem('CapacitorStorage.gloss_alt:' + w)
    return raw ? JSON.parse(raw) : null
  }, word)

await openReading()

console.log('\n[1] 本地有释义的词：只显示主释义 + 两个入口')
ok('点到了 filing', await clickWord('filing'))
let sheet = await sheetText()
ok('主释义来自本地词典', sheet.includes('锉'), sheet.slice(0, 60))
ok('没有 AI 行', (await has('alt-ai')) === false)
ok('没有自定义行', (await has('alt-custom')) === false)
ok('有「AI 释义」入口', await has('ask-ai'))
ok('有「自定义释义」入口', await has('add-custom'))

console.log('\n[2] 点「AI 释义」→ 多出一行，主释义不变')
await clickTestId('ask-ai')
ok('出现了 AI 行', await has('alt-ai'))
ok('AI 行内容正确', (await textOf('alt-ai')) === AI_FILING, await textOf('alt-ai'))
sheet = await sheetText()
ok('主释义没有被替换', sheet.includes('锉'), sheet.slice(0, 60))
ok('确实调了模型', llmCalls >= 1, String(llmCalls))
ok('落盘到 gloss_alt', (await altOf('filing'))?.ai === AI_FILING, JSON.stringify(await altOf('filing')))

console.log('\n[3] 关掉重开：AI 行持久化')
await closeSheet()
await clickWord('filing')
ok('重开后 AI 行还在', await has('alt-ai'))
ok('入口不再重复出现（已有内容）', (await has('ask-ai')) === false)

console.log('\n[4] 写自定义释义 → 两行并存')
await clickTestId('add-custom')
ok('出现输入框', await has('custom-input'))
await page.type('[data-testid="custom-input"]', MY_CUSTOM)
await clickTestId('save-custom')
ok('出现自定义行', await has('alt-custom'))
ok('自定义内容正确', (await textOf('alt-custom')) === MY_CUSTOM, await textOf('alt-custom'))
ok('AI 行没被顶掉', await has('alt-ai'))
ok('两份都存在', (await altOf('filing'))?.custom === MY_CUSTOM && (await altOf('filing'))?.ai === AI_FILING,
  JSON.stringify(await altOf('filing')))

console.log('\n[5] 编辑自定义释义')
await clickTestId('edit-custom')
await page.evaluate(() => {
  const el = document.querySelector('[data-testid="custom-input"]')
  if (el) el.value = ''
})
await page.click('[data-testid="custom-input"]', { clickCount: 3 })
await page.type('[data-testid="custom-input"]', 'n. 改过之后的释义')
await clickTestId('save-custom')
ok('内容更新了', (await textOf('alt-custom')) === 'n. 改过之后的释义', await textOf('alt-custom'))

console.log('\n[6] 删除自定义 → 只留 AI 行')
await clickTestId('drop-custom')
ok('自定义行消失', (await has('alt-custom')) === false)
ok('入口回来了', await has('add-custom'))
ok('AI 行还在', await has('alt-ai'))
ok('落盘里只剩 ai', (await altOf('filing'))?.custom === undefined && (await altOf('filing'))?.ai === AI_FILING,
  JSON.stringify(await altOf('filing')))
await closeSheet()

console.log('\n[7] 主释义本身就是 AI 的词：不另开一行')
ok('点到了 zorbix', await clickWord('zorbix'))
sheet = await sheetText()
ok('主释义是 AI 给的', sheet.includes(AI_ZORBIX), sheet.slice(0, 80))
ok('主释义旁标了「AI 释义」', sheet.includes('AI 释义'))
ok('没有重复的 AI 行', (await has('alt-ai')) === false)
ok('入口文案是「重新生成」', (await textOf('ask-ai')).includes('重新生成'), await textOf('ask-ai'))
await closeSheet()

console.log('\n[8] 主释义查不到时，自定义释义兜底')
ok('点到了 quibblex', await clickWord('quibblex'))
sheet = await sheetText()
ok('主释义位置显示自定义释义', sheet.includes(MY_CUSTOM), sheet.slice(0, 100))
ok('并标明来源是自定义', sheet.includes('自定义'))
ok('不重复显示第二行', (await has('alt-custom')) === false)
await closeSheet()

console.log('\n[9] 没有页面报错')
ok('无 pageerror', errors.length === 0, errors.join(' | '))

await browser.close()
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail > 0 ? 1 : 0)
