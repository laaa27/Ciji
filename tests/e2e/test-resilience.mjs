import puppeteer from 'puppeteer-core'

/**
 * 启动期韧性验证：重试、本地兜底、凭证错误不重试、栏目持久化。
 *
 * 先 `npx vite --port 5199`，再 `node tests/e2e/test-resilience.mjs`
 *
 * 这几条断言对应的是「偶发 500 不该让用户看到空页」这一组改动：
 * - 服务端返回一次 common_internal_error，应该自动再发一次，界面正常
 * - 本地有今天的数据 + 服务端全挂，仍然要能看到词，只多一条可点的提示
 * - 401 是凭证问题，重试没意义，只能发一次
 * - 停在哪个栏目要跨进程活下来（系统会杀掉 cached 进程）
 */

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP = process.env.PREVIEW_URL || 'http://localhost:5199/'

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date())

const WORDS = [
  ['abandon', 'FORGET'],
  ['scrutiny', 'VAGUE'],
  ['coherent', 'FAMILIAR'],
  ['eloquent', 'VAGUE'],
  ['prevalent', 'FAMILIAR'],
  ['concede', 'FORGET'],
]

const todayItems = WORDS.map(([spelling, first], i) => ({
  voc_id: `v-${i}`,
  voc_spelling: spelling,
  first_response: first,
  is_new: i % 2 === 0,
  is_finished: true,
  order: i,
}))

/** 和 data/store.ts 的落盘格式一致，供「本地兜底」用例预置 */
const daySnapshot = () => ({
  date: TODAY,
  finished: 12,
  total: 40,
  studyTimeMs: 900000,
  words: WORDS.map(([spelling, first], i) => ({
    vocId: `v-${i}`,
    spelling,
    groups: i % 2 === 0 ? ['new'] : first === 'FORGET' ? ['forget'] : ['vague'],
    isNew: i % 2 === 0,
    firstResponse: first,
    isFinished: true,
    order: i,
  })),
  collectedAt: new Date().toISOString(),
  rawCount: WORDS.length,
  studiedCount: WORDS.length,
})

const okData = (data) => ({ status: 200, body: { success: true, data } })
const internalError = () => ({
  status: 200,
  body: { success: false, errors: [{ code: 'common_internal_error', msg: 'Internal server error' }] },
})
const unauthorized = () => ({
  status: 401,
  body: { success: false, errors: [{ code: 'common_unauthorized', msg: 'Authorization failed' }] },
})

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
})

/**
 * 开一个干净的页面：拦截墨墨接口与在线查词，按 plan 决定每次返回什么。
 * @param plan (kind, nth) => { status, body }
 */
async function open({ plan, seedDay = false, token = true }) {
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })

  const calls = {}
  await page.setRequestInterception(true)

  // 首次加载时上个用例残留的 token 可能让 App 先发一轮请求（机器慢时还会越过
  // 计数器重置点污染计数）。所以加一道门闸：种子落库前的 /open/ 请求一律
  // 用空响应打发、不计数，从 reload 之后才开始正常计数。
  let countable = false

  page.on('request', (req) => {
    const url = req.url()

    const reply = (r) => {
      req
        .respond({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) })
        .catch(() => {})
    }

    // 在线查词：真连 MyMemory 会拖慢测试，直接给个假释义
    if (url.includes('mymemory')) {
      return reply({ status: 200, body: { responseData: { translatedText: '（释义）' } } })
    }

    if (!url.includes('/open/')) return req.continue()

    if (!countable) return reply({ status: 200, body: { success: true, data: {} } })

    const kind = url.includes('get_study_progress')
      ? 'progress'
      : url.includes('get_today_items')
        ? 'today'
        : url.includes('query_study_records')
          ? 'records'
          : url.includes('vocabulary')
            ? 'vocab'
            : 'other'

    calls[kind] = (calls[kind] ?? 0) + 1
    if (process.env.DEBUG_REQ === '1') {
      console.log(`    → ${kind} #${calls[kind]} @${Date.now() % 100000}`)
    }
    reply(plan(kind, calls[kind]))
  })

  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ({ today, seed, hasToken, snapshot }) => {
      localStorage.clear()
      if (hasToken) localStorage.setItem('CapacitorStorage.maimemo_token', 'seed-token')
      if (seed) localStorage.setItem('CapacitorStorage.day:' + today, JSON.stringify(snapshot))
    },
    { today: TODAY, seed: seedDay, hasToken: token, snapshot: seedDay ? daySnapshot() : null },
  )

  // 种子已落库、门闸放行：从 reload 之后开始正常计数
  countable = true
  for (const k of Object.keys(calls)) delete calls[k]

  await page.reload({ waitUntil: 'domcontentloaded' })
  // 重试要等 700ms，加上两次采集，留 2.6s
  await sleep(2600)

  return { page, calls }
}

const text = (page) => page.evaluate(() => document.body.innerText)

/* ── [1] 服务端抖一次，应该自动补一次并正常渲染 ── */
console.log('\n[1] common_internal_error 自动重试一次')
{
  const { page, calls } = await open({
    plan: (kind, nth) => {
      if (kind === 'today') return nth === 1 ? internalError() : okData({ today_items: todayItems })
      if (kind === 'progress') return okData({ progress: { finished: 12, total: 40, study_time: 900000 } })
      if (kind === 'records') return okData({ records: [], count: 0 })
      return okData({})
    },
  })

  ok('get_today_items 发了 2 次', calls.today === 2, calls.today)
  ok('get_study_progress 只发了 1 次（没失败不重试）', calls.progress === 1, calls.progress)

  const body = await text(page)
  ok('词表照常渲染', body.includes('abandon') && body.includes('concede'))
  ok('没有整页错误卡', !body.includes('没能读到数据'))
  ok('没有遗留的失败提示', !body.includes('这次没刷上'))
  ok('进度数字来自服务端', body.includes('12') && body.includes('40'))

  await page.close()
}

/* ── [2] 服务端全挂 + 本地有数据：仍要能看到词 ── */
console.log('\n[2] 服务端全挂，本地数据兜底')
{
  const { page, calls } = await open({
    seedDay: true,
    plan: () => internalError(),
  })

  ok('读接口确实重试过', (calls.today ?? 0) >= 2, calls.today)

  const body = await text(page)
  ok('本地快照的词仍然显示', body.includes('abandon') && body.includes('scrutiny'))
  ok('没有整页错误卡', !body.includes('没能读到数据'))
  ok('出现一条可点的失败提示', body.includes('这次没刷上'))

  const hint = await page.$('[data-testid="refresh-failed"]')
  ok('提示是可点的按钮', Boolean(hint))

  // 点一下应该再发一轮请求（说明重试入口是通的）
  const before = calls.today ?? 0
  if (hint) await hint.click()
  await sleep(1800)
  ok('点提示会重新请求', (calls.today ?? 0) > before, `${before} → ${calls.today}`)

  await page.close()
}

/* ── [3] 401 是凭证问题，重试没有意义 ── */
console.log('\n[3] 401 不重试')
{
  const { page, calls } = await open({
    plan: (kind) => (kind === 'today' || kind === 'progress' ? unauthorized() : okData({})),
  })

  ok('get_today_items 只发了 1 次', calls.today === 1, calls.today)
  ok('get_study_progress 只发了 1 次', calls.progress === 1, calls.progress)

  const body = await text(page)
  ok('文案指向凭证问题', body.includes('凭证无效'))
  ok('文案里没有「已自动重试」', !body.includes('已自动重试'))

  await page.close()
}

/* ── [4] 失败详情要能看出状态码（500 还是 200 带信封） ── */
console.log('\n[4] 失败详情')
{
  const http500 = () => ({
    status: 500,
    body: { success: false, errors: [{ code: 'common_internal_error', msg: 'Internal server error' }] },
  })

  const { page } = await open({
    seedDay: true,
    plan: () => http500(),
  })

  const detail = await page.$('[data-testid="refresh-detail"]')
  ok('出现「详情」入口', Boolean(detail))

  const detailText = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="refresh-detail"]')
    return el?.textContent ?? ''
  })
  ok('详情里写明 HTTP 状态', detailText.includes('HTTP 500'), detailText.slice(0, 60))
  ok('详情里带错误码', detailText.includes('common_internal_error'), detailText.slice(0, 60))
  ok('详情里带原始响应', detailText.includes('Internal server error'))

  await page.close()
}

/* ── [5] 停在哪个栏目要跨进程活下来 ── */
console.log('\n[5] 栏目持久化')
{
  const { page } = await open({
    plan: (kind) => {
      if (kind === 'today') return okData({ today_items: todayItems })
      if (kind === 'progress') return okData({ progress: { finished: 12, total: 40, study_time: 900000 } })
      return okData({ records: [], count: 0 })
    },
  })

  const activeTab = () =>
    page.evaluate(() => {
      const el = document.querySelector('nav button[data-active="true"]')
      return el?.textContent?.trim() ?? ''
    })

  ok('默认在今日', (await activeTab()) === '今日', await activeTab())

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('nav button')].find(
      (b) => b.textContent?.trim() === '历史',
    )
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(400)
  ok('切到历史', (await activeTab()) === '历史', await activeTab())

  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(1200)
  ok('刷新后仍在历史', (await activeTab()) === '历史', await activeTab())

  await page.close()
}

await browser.close()

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
