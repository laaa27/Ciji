import puppeteer from 'puppeteer-core'

/**
 * 生成后审计（auditArticle）的浏览器验证。
 *
 * 先 `vite preview --port 5199`（或 dev server），再 `node tests/e2e/verify-article-audit.mjs`
 *
 * 两个场景：
 *   1. 第一次返回残篇（几十词）→ 应该自动重新生成，最终拿到长的那篇，且不标「篇幅偏短」
 *   2. 两次都是残篇 → 应该交出其中一篇，并在阅读页标注「篇幅偏短」
 *
 * 这两个断言对治的是一个真实故障：deepseek-flash 有 ~30% 的生成会塌成一百多词的残篇。
 */

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const APP = process.env.PREVIEW_URL || 'http://localhost:5199/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date())

const WORDS = [
  'abandon', 'scrutiny', 'prevalent', 'coherent', 'concede', 'meticulous',
  'resilient', 'arbitrary', 'detrimental', 'dilemma', 'incentive', 'profound',
]

/** 12 个词塞进今天的快照，类型给「忘记」，保证生成页默认选中 */
const SNAPSHOT = {
  date: today,
  finished: 12,
  total: 40,
  studyTimeMs: 900000,
  words: WORDS.map((w, i) => ({
    vocId: `v${i}`,
    spelling: w,
    groups: ['forget'],
    isNew: false,
    firstResponse: 'FORGET',
    isFinished: true,
    order: i,
  })),
  collectedAt: new Date().toISOString(),
  rawCount: 12,
  studiedCount: 12,
}

const shortSentences = () => [
  { en: `We should abandon the ${WORDS[0]} habit now.`, zh: '我们应该立刻放弃这个习惯。' },
  { en: `That is a ${WORDS[1]} question for all of us.`, zh: '那对我们所有人都是个问题。' },
]

const longSentences = () => {
  const out = []
  for (let i = 0; i < 40; i += 1) {
    const w = WORDS[i % WORDS.length]
    out.push({
      en: `Researchers keep returning to the ${w} question, and their conclusions, which once looked settled, remain open to careful debate among those who follow the field closely.`,
      zh: `研究者不断回到 ${w} 这个问题上，而他们的结论——曾经看似已有定论——在密切关注该领域的人中间仍然值得仔细讨论。`,
    })
  }
  return out
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

/**
 * 跑一个场景。
 * @param plan (nth) => 'short' | 'long'   第 n 次「成文」请求返回什么
 */
async function runScenario(name, plan) {
  console.log(`\n${name}`)

  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })

  let articleCalls = 0
  await page.setRequestInterception(true)

  page.on('request', (req) => {
    const url = req.url()
    if (!url.includes('/__llm')) return req.continue()

    const body = req.postData() ?? ''
    const isOutline = !body.includes('必须包含的单词')
    let payload

    if (isOutline) {
      payload = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                topic: '为什么我们重复犯同样的错',
                paragraphs: [
                  { idea: '开篇', link: '开篇', words: WORDS.slice(0, 4) },
                  { idea: '论证', link: '递进', words: WORDS.slice(4, 8) },
                  { idea: '收束', link: '转折', words: WORDS.slice(8) },
                ],
              }),
            },
            finish_reason: 'stop',
          },
        ],
      }
    } else {
      articleCalls += 1
      const kind = plan(articleCalls)
      payload = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: kind === 'long' ? 'AUDIT-LONG' : 'AUDIT-SHORT',
                titleZh: '审计样例',
                sentences: kind === 'long' ? longSentences() : shortSentences(),
              }),
            },
            finish_reason: 'stop',
          },
        ],
      }
    }

    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }).catch(() => {})
  })

  await page.goto(APP, { waitUntil: 'networkidle0' })
  await page.evaluate((snap) => {
    localStorage.clear()
    localStorage.setItem('CapacitorStorage.maimemo_token', 'seed')
    localStorage.setItem('CapacitorStorage.day:' + snap.date, JSON.stringify(snap))
    localStorage.setItem(
      'CapacitorStorage.llm_profiles',
      JSON.stringify([
        {
          id: 'p1', name: '测试模型', protocol: 'openai',
          baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-test', model: 'gpt-x',
          createdAt: new Date().toISOString(),
        },
      ]),
    )
    localStorage.setItem('CapacitorStorage.llm_active', 'p1')
  }, SNAPSHOT)
  await page.reload({ waitUntil: 'networkidle0' })
  await sleep(700)

  const tabs = await page.$$('nav button')
  await tabs[2].click()
  await sleep(700)

  const click = (text) =>
    page.evaluate((needle) => {
      const want = needle.replace(/\s+/g, '')
      const btn = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.replace(/\s+/g, '').includes(want),
      )
      if (btn) btn.click()
      return Boolean(btn)
    }, text)

  await click('生成')
  await sleep(900)
  await click('个词生成')

  // 两次成文 + 提纲，各 350ms 级；留足重生成的余量
  await sleep(2600)

  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  return { page, text, articleCalls }
}

/* ── 场景 1：残篇 → 重生成成功 ── */
{
  const { page, text, articleCalls } = await runScenario('[1] 首篇残篇 → 自动重生成', (n) =>
    n === 1 ? 'short' : 'long',
  )
  ok('成文被请求了 2 次（触发重生成）', articleCalls === 2, articleCalls)
  ok('最终拿到的是长的那篇', text.includes('AUDIT-LONG'), text.slice(0, 80))
  ok('没有标「篇幅偏短」', !text.includes('篇幅偏短'))
  await page.close()
}

/* ── 场景 2：两次都残篇 → 标注 ── */
{
  const { page, text, articleCalls } = await runScenario('[2] 两次都残篇 → 交出并标注', () => 'short')
  ok('成文被请求了 2 次（用尽重试）', articleCalls === 2, articleCalls)
  ok('阅读页标了「篇幅偏短」', text.includes('篇幅偏短'), text.slice(0, 80))
  ok('文章仍然可读（有标题）', text.includes('AUDIT-SHORT'), text.slice(0, 80))
  await page.close()
}

await browser.close()
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail > 0 ? 1 : 0)
