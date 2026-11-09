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

// 接下来 N 次请求返回空 content，用来验证空响应重试
let emptyNext = 0

// 依次消费的「脚本文档」：用来模拟 400 参数不兼容等特定响应
let script = []

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

  if (script.length > 0) {
    const step = script.shift()
    req.respond({
      status: step.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(step.body),
    })
    return
  }

  if (emptyNext > 0) {
    emptyNext -= 1
    req.respond({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        isAnthropic
          ? { content: [], stop_reason: 'end_turn' }
          : { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
      ),
    })
    return
  }

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
    // 两边都去掉空白再比，否则「Anthropic Claude」这类带空格的按钮永远匹配不上
    const want = needle.replace(/\s+/g, '')
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.replace(/\s+/g, '').includes(want),
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

async function addProfile(name, key) {
  await clickText('添加模型')
  await t(300)
  await clickText('自定义')
  await t(200)
  await fill('input[placeholder="随便起，用来在列表里区分"]', name)
  await fill('input[inputmode="url"]', 'https://gw.example.com/v1')
  await fill('input[placeholder^="例如"]', 'o3-mini')
  await fill('input[placeholder="粘贴 API Key"]', key)
  await t(150)
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

// 0.21 起设置改为分类导航，模型配置挪进了「大模型」二级页
await clickText('大模型')
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

console.log('\n[6] 选预设后切换接口格式，高亮不能丢')
await clickText('添加模型')
await t(300)
await clickText('Anthropic Claude')
await t(200)
const chipsOn = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter((b) => b.dataset.on === 'true')
      .map((b) => b.textContent?.trim()),
  )
ok('选中 Anthropic 预设后高亮', (await chipsOn()).includes('Anthropic Claude'), await chipsOn())
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'OpenAI 兼容')
  b?.click()
})
await t(250)
ok('切到 OpenAI 格式后仍然高亮', (await chipsOn()).includes('Anthropic Claude'), await chipsOn())
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Anthropic')
  b?.click()
})
await t(250)
ok('切回 Anthropic 格式也还在', (await chipsOn()).includes('Anthropic Claude'), await chipsOn())
await clickText('取消')
await t(200)

console.log('\n[7] 空内容自动重试')
await clickText('添加模型')
await t(300)
await clickText('自定义')
await t(200)
await fill('input[placeholder="随便起，用来在列表里区分"]', '空响应测试')
await fill('input[inputmode="url"]', 'https://gw.example.com/v1')
await fill('input[placeholder^="例如"]', 'gpt-x')
await fill('input[placeholder="粘贴 API Key"]', 'sk-empty')
await t(150)

// 第一次返回空，第二次正常 → 应当自动重试并成功
emptyNext = 1
calls.length = 0
await clickText('测试并保存')
await t(1400)
ok('自动重试了一次', calls.length === 2, calls.length)
ok('重试后成功了', (await bodyText()).includes('连接成功'), (await bodyText()).match(/连接[^。]{0,20}/)?.[0])

// 连续两次空 → 明确报「已自动重试一次」，而不是笼统的「空内容」
await clickText('添加模型')
await t(300)
await clickText('自定义')
await t(200)
await fill('input[placeholder="随便起，用来在列表里区分"]', '空响应失败')
await fill('input[inputmode="url"]', 'https://gw.example.com/v1')
await fill('input[placeholder^="例如"]', 'gpt-x')
await fill('input[placeholder="粘贴 API Key"]', 'sk-empty2')
await t(150)

emptyNext = 2
calls.length = 0
await clickText('测试并保存')
await t(1600)
ok('两次都空时共请求 2 次', calls.length === 2, calls.length)
ok('报错说明已自动重试', (await bodyText()).includes('已自动重试一次'), (await bodyText()).match(/模型返回[^。]{0,40}/)?.[0])
await clickText('取消')
await t(200)

console.log('\n[8] 推理模型：max_tokens 改名后自动重发')
await addProfile('推理模型', 'sk-reason-1')
script = [
  {
    status: 400,
    body: {
      error: {
        message:
          "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        type: 'invalid_request_error',
      },
    },
  },
]
calls.length = 0
await clickText('测试并保存')
await t(1600)
ok('撞 400 后又发了一次', calls.length === 2, calls.length)
ok(
  '改用了 max_completion_tokens',
  calls[1]?.body?.max_completion_tokens !== undefined && calls[1]?.body?.max_tokens === undefined,
  calls[1]?.body,
)
ok('重发后成功', (await bodyText()).includes('连接成功'), (await bodyText()).match(/Unsupported[^。]{0,40}/)?.[0])

// 同一份配置再测一次：应该直接带上协商好的参数，不再撞 400
await page.evaluate(() => {
  const row = [...document.querySelectorAll('li')].find((li) => li.textContent?.includes('推理模型'))
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === '编辑')
  if (btn) btn.click()
})
await t(400)
calls.length = 0
await clickText('测试并保存')
await t(1200)
ok('同一配置第二次只发一次请求', calls.length === 1, calls.length)
ok('已记住参数名', calls[0]?.body?.max_completion_tokens !== undefined, calls[0]?.body)

console.log('\n[9] 推理模型：temperature 不被接受时去掉')
await addProfile('推理模型二', 'sk-reason-2')
script = [
  {
    status: 400,
    body: {
      error: {
        message: "Unsupported value: 'temperature' does not support 0.85 with this model. Only the default (1) is supported.",
        type: 'invalid_request_error',
      },
    },
  },
]
calls.length = 0
await clickText('测试并保存')
await t(1600)
ok('第二次请求不再带 temperature', calls[1] && !('temperature' in calls[1].body), calls[1]?.body)
ok('去掉后成功', (await bodyText()).includes('连接成功'))

console.log('\n[10] 推理模型：预算被思维链吃光时自动加大')
await addProfile('推理模型三', 'sk-reason-3')
script = [{ status: 200, body: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } }]
calls.length = 0
await clickText('测试并保存')
await t(1800)
ok('第一次 max_tokens 是原值', calls[0]?.body?.max_tokens === 32, calls[0]?.body?.max_tokens)
ok('重试时撑到 8000', calls[1]?.body?.max_tokens >= 8000, calls[1]?.body?.max_tokens)
ok('撑大后成功', (await bodyText()).includes('连接成功'))

console.log('\n[11] 无 JS 报错')
ok('页面干净', errors.length === 0, errors.slice(0, 3))

console.log(`\n通过 ${pass} / 失败 ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
