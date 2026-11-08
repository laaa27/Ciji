import puppeteer from 'puppeteer-core'

/**
 * 阅读页三件事的浏览器验证：
 *   1. 切到别的栏目再回来，译文开关 / 滚动位置 / 当前文章都还在
 *   2. 生成过程中切走，生成继续，完成后弹 toast
 *   3. 顶部「译文 / 字号 / 生成」吸顶，滑下去仍然够得着
 *
 * 先 `npx vite --port 5199`，再 `node scripts/test-reading.mjs`
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

// 今日词表：够 pickWords 用
const POOL = [
  'abandon', 'scrutiny', 'coherent', 'eloquent', 'prevalent', 'concede', 'reluctant',
  'ambiguous', 'implicit', 'notorious', 'vulnerable', 'meticulous', 'pragmatic',
  'tentative', 'obscure', 'resilient', 'candid', 'dubious', 'feasible', 'intricate',
]
const todayItems = POOL.map((w, i) => ({
  voc_id: `v-${i}`,
  voc_spelling: w,
  first_response: i % 3 === 0 ? 'VAGUE' : 'FORGET',
  is_new: i % 4 === 0,
  is_finished: true,
  order: i,
}))

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

let llmCalls = 0
let articleNo = 0
const t = (ms) => new Promise((r) => setTimeout(r, ms))

await page.setRequestInterception(true)
page.on('request', (req) => {
  const url = req.url()

  if (url.includes('/open/')) {
    const json = (body) =>
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: body }) })
    if (url.includes('get_study_progress')) return json({ progress: { finished: 20, total: 180, study_time: 900000 } })
    if (url.includes('get_today_items')) return json({ today_items: todayItems })
    return json({ records: [], count: 0 })
  }

  if (url.includes('/__llm')) {
    llmCalls += 1
    // 奇数次是提纲，偶数次是正文；故意慢一点，好在生成途中切栏目
    const body = JSON.parse(req.postData() ?? '{}')
    const isOutline = llmCalls % 2 === 1
    const payload = isOutline
      ? {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  topic: '为什么习惯比意志力可靠',
                  paragraphs: [
                    { idea: 'concede 开篇', link: '开篇', words: POOL.slice(0, 6) },
                    { idea: '论证', link: '递进', words: POOL.slice(6, 14) },
                    { idea: '结论', link: '收束', words: POOL.slice(14) },
                  ],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }
      : (() => {
          articleNo += 1
          const sentences = Array.from({ length: 12 }, (_, i) => ({
            en: `Sentence ${i + 1} mentions ${POOL[i % POOL.length]} in a calm, deliberate way that keeps the argument moving forward without noise.`,
            zh: `第 ${i + 1} 句用平静而克制的方式提到了 ${POOL[i % POOL.length]}，让论证继续向前推进。`,
          }))
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: `The Weight of Habit ${articleNo}`,
                    titleZh: '习惯的重量',
                    sentences,
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          }
        })()

    setTimeout(() => {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
      // 记录请求体，确认用的是哪个模型（这里只看次数）
      if (body.model === undefined) errors.push('请求里没有 model 字段')
    }, 400)
    return
  }

  return req.continue()
})

await page.goto(APP, { waitUntil: 'networkidle0' })

await page.evaluate(() => {
  localStorage.clear()
  localStorage.setItem('CapacitorStorage.maimemo_token', 'seed')
  localStorage.setItem(
    'CapacitorStorage.llm_profiles',
    JSON.stringify([
      {
        id: 'p1',
        name: '测试模型',
        protocol: 'openai',
        baseUrl: 'https://gw.example.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-x',
        createdAt: new Date().toISOString(),
      },
    ]),
  )
  localStorage.setItem('CapacitorStorage.llm_active', 'p1')
})

await page.reload({ waitUntil: 'networkidle0' })
await t(600)

const tabs = await page.$$('nav button')
const clickText = (text) =>
  page.evaluate((needle) => {
    const want = needle.replace(/\s+/g, '')
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.replace(/\s+/g, '').includes(want),
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, text)

const bodyText = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
const scrollTo = async (y) => {
  await page.evaluate((target) => {
    const scroller = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 100)
    if (scroller) scroller.scrollTop = target
  }, y)
  await t(250)
}
const scrollTop = () =>
  page.evaluate(() => {
    const scroller = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 100)
    return scroller ? Math.round(scroller.scrollTop) : -1
  })

console.log('\n[1] 首次生成')
await tabs[2].click()
await t(500)
await clickText('生成一篇文章')
await t(2500)
ok('文章已生成', (await bodyText()).includes('The Weight of Habit 1'), (await bodyText()).slice(0, 80))
ok('两次调用（提纲 + 正文）', llmCalls === 2, llmCalls)

console.log('\n[2] 切栏目后状态保留')
await clickText('译文')
await t(300)
ok('译文已开启', (await bodyText()).includes('第 1 句用平静'), (await bodyText()).slice(0, 60))

await scrollTo(420)
const y1 = await scrollTop()
ok('已滚动到 420', Math.abs(y1 - 420) <= 2, y1)

await tabs[0].click() // 今日
await t(400)
await tabs[2].click() // 回阅读
await t(500)

ok('文章还在', (await bodyText()).includes('The Weight of Habit 1'))
ok('译文仍是开着的', (await bodyText()).includes('第 1 句用平静'))
ok('滚动位置恢复', Math.abs((await scrollTop()) - 420) <= 2, await scrollTop())

const zhOn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '译文')
  return b?.dataset.on
})
ok('译文按钮是高亮态', zhOn === 'true', zhOn)

console.log('\n[3] 顶部工具条吸顶')
await scrollTo(700)
const head = await page.evaluate(() => {
  const el = [...document.querySelectorAll('header')].find((h) => h.textContent?.includes('阅读'))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: Math.round(r.top), stuck: el.dataset.stuck, height: Math.round(r.height) }
})
ok('标题吸在 30px 处', head && Math.abs(head.top - 30) <= 2, head?.top)
ok('标记为已贴住', head?.stuck === 'true', head?.stuck)

const visible = await page.evaluate(() => {
  const labels = ['译文', '字号', '生成']
  return labels.map((l) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === l)
    if (!b) return { l, top: null }
    const r = b.getBoundingClientRect()
    return { l, top: Math.round(r.top), inView: r.top >= 0 && r.top < 120 }
  })
})
ok('三颗按钮都在可视区内', visible.every((v) => v.inView), JSON.stringify(visible))

console.log('\n[4] 生成中切走，生成继续并弹提示')
await clickText('生成') // 展开生成选项
await t(400)
await clickText('再生成一篇')
await t(150)
await tabs[0].click() // 立刻切到今日
await t(2600) // 等生成完成（每次调用 400ms）

const toast = await page.evaluate(() => {
  const el = document.querySelector('[role="status"]')
  return el ? el.textContent?.trim() : null
})
ok('切走后弹了提示', toast === '文章生成好了', toast)

await tabs[2].click()
await t(600)
ok('新文章已就位', (await bodyText()).includes('The Weight of Habit 2'), (await bodyText()).slice(0, 80))
ok('两次生成共 4 次调用', llmCalls === 4, llmCalls)

console.log('\n[5] 统计页图表切回来尺寸正常')
await tabs[3].click()
await t(1200)
const c1 = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  return c ? { w: c.width, h: c.height } : null
})
ok('图表首次挂载有尺寸', c1 && c1.w > 100 && c1.h > 50, JSON.stringify(c1))

await tabs[0].click()
await t(400)
await tabs[3].click()
await t(800)
const c2 = await page.evaluate(() => {
  const c = document.querySelector('canvas')
  return c ? { w: c.width, h: c.height } : null
})
ok('切回来尺寸没被压成 0', c2 && c2.w > 100 && c2.h > 50, JSON.stringify(c2))

console.log('\n[6] 文章库：入口、排序、打开、删除')
await tabs[2].click()
await t(500)

const hasButton = (text) =>
  page.evaluate((t) => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === t), text)

ok('标题行有文章库入口', await hasButton('文章库'))
await clickText('文章库')
await t(500)

let libText = await bodyText()
ok('进入文章库页面', libText.includes('2 篇'), libText.slice(0, 60))
ok(
  '最新的排在前面',
  libText.indexOf('The Weight of Habit 2') < libText.indexOf('The Weight of Habit 1'),
  libText.slice(0, 90),
)

// 打开第一行（最新那篇）。
// 注意不能直接取 document.querySelector('li')：其它栏目是 display:none 但仍挂在 DOM 里，
// 今日页的词条也是 li，会先被选中。按标题定位到文章库那一行。
await page.evaluate(() => {
  const li = [...document.querySelectorAll('li')].find((x) =>
    x.textContent?.includes('The Weight of Habit 2'),
  )
  li?.querySelector('button')?.click()
})
await t(600)
ok('打开文章后回到阅读页', (await bodyText()).includes('The Weight of Habit 2'))
ok('文章库入口仍在', await hasButton('文章库'))

// 把第一篇删掉：两次点击
await clickText('文章库')
await t(400)
const removeRow = async (title) => {
  const first = await page.evaluate((t) => {
    const li = [...document.querySelectorAll('li')].find((x) => x.textContent?.includes(t))
    const btn = [...(li?.querySelectorAll('button') ?? [])].find((b) =>
      ['删除', '确认'].includes(b.textContent?.trim() ?? ''),
    )
    if (btn) btn.click()
    return btn ? btn.textContent?.trim() : null
  }, title)
  return first
}

const label1 = await removeRow('The Weight of Habit 1')
ok('第一次点删除只变成确认', label1 === '删除')
await t(300)
const label2 = await removeRow('The Weight of Habit 1')
ok('第二次点的是确认', label2 === '确认')
await t(600)

libText = await bodyText()
ok('删掉后只剩 1 篇', libText.includes('1 篇'), libText.slice(0, 40))
ok('被删的那篇从列表消失', !libText.includes('The Weight of Habit 1'), libText.slice(0, 120))

const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('CapacitorStorage.article_index') || '[]'))
ok('索引同步删掉了', stored.length === 1 && stored[0].title === 'The Weight of Habit 2', stored.length)

// 删掉正在打开的最后一篇
await removeRow('The Weight of Habit 2')
await t(300)
await removeRow('The Weight of Habit 2')
await t(700)
libText = await bodyText()
ok('列表空了', libText.includes('0 篇'), libText.slice(0, 40))

await clickText('返回')
await t(600)
ok('回到阅读页且没有文章', (await bodyText()).includes('生成一篇文章'), (await bodyText()).slice(0, 80))

console.log('\n[7] 无 JS 报错')
ok('页面干净', errors.length === 0, errors.slice(0, 3))

console.log(`\n通过 ${pass} / 失败 ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
