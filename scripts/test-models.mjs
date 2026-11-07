import puppeteer from 'puppeteer-core'

/**
 * 多模型配置的浏览器冒烟测试（不需要真实 API Key）。
 *
 * 用请求拦截把 /__llm 的响应换掉，从而真实验证：
 *   旧配置迁移 → 添加（OpenAI 协议）→ 切换 → 编辑成 Anthropic → 删除
 * 同时断言两种协议发出的 URL / 请求头 / 请求体确实不同。
 *
 * 用法：先 `npx vite --port 5199`，再 `node scripts/test-models.mjs`
 */

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_URL = process.env.PREVIEW_URL || 'http://localhost:5199/'
const OUT = process.argv[2] || 'models-check.png'

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
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
})

// 记下每次被拦截的请求，用来断言协议差异
const calls = []
await page.setRequestInterception(true)
page.on('request', (req) => {
  if (!req.url().includes('/__llm')) {
    req.continue()
    return
  }
  calls.push({
    url: decodeURIComponent(new URL(req.url()).searchParams.get('url') ?? ''),
    headers: req.headers(),
    body: req.postData() ? JSON.parse(req.postData()) : null,
  })

  const target = calls[calls.length - 1].url
  const isAnthropic = target.includes('/messages')
  req.respond({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(
      isAnthropic
        ? { content: [{ type: 'text', text: '正常' }], stop_reason: 'end_turn' }
        : { choices: [{ message: { content: '正常' }, finish_reason: 'stop' }] },
    ),
  })
})

const t = (ms) => new Promise((r) => setTimeout(r, ms))

const clickText = (text) =>
  page.evaluate((needle) => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.replace(/\s+/g, '').includes(needle),
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, text)

const bodyText = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))

const store = () =>
  page.evaluate(() => ({
    profiles: JSON.parse(localStorage.getItem('CapacitorStorage.llm_profiles') || '[]'),
    active: localStorage.getItem('CapacitorStorage.llm_active'),
    legacy: localStorage.getItem('CapacitorStorage.llm_key'),
  }))

async function fill(selector, text) {
  const found = await page.evaluate(
    (sel, value) => {
      const el = document.querySelector(sel)
      if (!el) return false
      // React 受控输入：必须走原生 setter + input 事件，直接改 value 不会同步状态
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    },
    selector,
    text,
  )
  if (!found) throw new Error(`找不到输入框 ${selector}`)
  await t(60)
}

async function goto(sel) {
  const el = await page.$(sel)
  if (el) await el.evaluate((n) => n.scrollIntoView({ block: 'center' }))
  await t(200)
}

await page.goto(APP_URL, { waitUntil: 'networkidle0' })

// 旧版单 key 数据
await page.evaluate(() => {
  localStorage.clear()
  localStorage.setItem('CapacitorStorage.llm_provider', 'deepseek')
  localStorage.setItem('CapacitorStorage.llm_key', 'sk-old-key')
  localStorage.setItem('CapacitorStorage.llm_model', 'deepseek-chat')
})
await page.reload({ waitUntil: 'networkidle0' })

const tabs = await page.$$('nav button')
await tabs[4].click()
await t(600)

console.log('\n[1] 旧配置迁移')
let s = await store()
ok('迁出一条配置', s.profiles.length === 1, s.profiles.length)
ok('沿用旧 key', s.profiles[0]?.apiKey === 'sk-old-key')
ok('沿用旧模型名', s.profiles[0]?.model === 'deepseek-chat', s.profiles[0]?.model)
ok('命名取厂商', s.profiles[0]?.name === 'DeepSeek', s.profiles[0]?.name)
ok('自动选中', s.active === s.profiles[0]?.id)
ok('旧键已清理', s.legacy === null, s.legacy)
ok('列表显示当前标记', (await bodyText()).includes('deepseek-chat · OpenAI 兼容 · 当前'))

console.log('\n[2] 添加一个 OpenAI 兼容配置')
await clickText('添加模型')
await t(400)
await clickText('自定义')
await t(200)
await fill('input[placeholder="随便起，用来在列表里区分"]', '我的中转')
await fill('input[inputmode="url"]', 'https://gw.example.com/v1')
await fill('input[placeholder^="例如"]', 'gpt-4o-mini')
await fill('input[placeholder="粘贴 API Key"]', 'sk-custom-1')
await t(150)

calls.length = 0
await clickText('测试并保存')
await t(800)

ok('发出了请求', calls.length === 1, calls.length)
ok(
  'URL 正确',
  calls[0]?.url === 'https://gw.example.com/v1/chat/completions',
  calls[0]?.url,
)
ok('Bearer 鉴权', calls[0]?.headers.authorization === 'Bearer sk-custom-1', calls[0]?.headers.authorization)
ok('带模型名', calls[0]?.body?.model === 'gpt-4o-mini', calls[0]?.body?.model)
ok('max_tokens 存在', typeof calls[0]?.body?.max_tokens === 'number')
s = await store()
ok('已保存两份', s.profiles.length === 2, s.profiles.length)
ok('新配置成为当前', s.active === s.profiles[1]?.id, s.active)
ok('提示测试成功', (await bodyText()).includes('连接成功'))
ok('列表出现新名称', (await bodyText()).includes('我的中转'))

console.log('\n[3] 切换模型')
const firstId = s.profiles[0].id
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button[aria-pressed]')].find((b) =>
    b.textContent?.includes('DeepSeek'),
  )
  if (btn) btn.click()
})
await t(400)
s = await store()
ok('切回 DeepSeek', s.active === firstId, s.active)
ok('界面标记跟着变', (await bodyText()).includes('deepseek-chat · OpenAI 兼容 · 当前'))

console.log('\n[4] 编辑成 Anthropic 协议')
await page.evaluate(() => {
  const row = [...document.querySelectorAll('li')].find((li) => li.textContent?.includes('我的中转'))
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === '编辑')
  if (btn) btn.click()
})
await t(400)
await clickText('Anthropic')
await t(200)
await fill('input[inputmode="url"]', 'https://api.anthropic.com')
await fill('input[placeholder^="例如"]', 'claude-sonnet-4-5')
await t(150)

calls.length = 0
await clickText('测试并保存')
await t(800)

ok('打到 /v1/messages', calls[0]?.url === 'https://api.anthropic.com/v1/messages', calls[0]?.url)
ok('x-api-key 鉴权', calls[0]?.headers['x-api-key'] === 'sk-custom-1', calls[0]?.headers['x-api-key'])
ok('anthropic-version 头', calls[0]?.headers['anthropic-version'] === '2023-06-01')
ok('没有 Bearer', calls[0]?.headers.authorization === undefined, calls[0]?.headers.authorization)
ok('body 有 max_tokens', typeof calls[0]?.body?.max_tokens === 'number')
ok('body 无 system 字段（本轮只有 user）', calls[0]?.body?.system === undefined)
s = await store()
ok('协议已改', s.profiles[1]?.protocol === 'anthropic', s.profiles[1]?.protocol)
ok('地址已改', s.profiles[1]?.baseUrl === 'https://api.anthropic.com')

await page.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find((x) => x.textContent?.trim() === '大模型')
  h?.scrollIntoView({ block: 'start' })
})
await t(300)
await page.screenshot({ path: OUT })

console.log('\n[5] 校验与删除')
await clickText('添加模型')
await t(300)
await clickText('测试并保存')
await t(300)
ok(
  '空 Key 被拦下（预填了名称/地址/模型）',
  (await bodyText()).includes('API Key 不能为空'),
  (await bodyText()).match(/.{0,8}不能为空/)?.[0],
)
await clickText('取消')
await t(300)

const del = async () => {
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('li')].find((li) => li.textContent?.includes('我的中转'))
    const btn = [...row.querySelectorAll('button')].find((b) =>
      ['删除', '确认'].includes(b.textContent?.trim() ?? ''),
    )
    if (btn) btn.click()
  })
  await t(300)
}
await del()
ok('第一次点删除只提示确认', (await store()).profiles.length === 2)
ok('显示确认提示', (await bodyText()).includes('再点一次确认删除'))
await del()
s = await store()
ok('第二次真删掉', s.profiles.length === 1, s.profiles.length)
ok('当前选中退回剩下的', s.active === firstId, s.active)

console.log('\n[6] 无 JS 报错')
ok('页面干净', errors.length === 0, errors.slice(0, 3))

console.log(`\n通过 ${pass} / 失败 ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
