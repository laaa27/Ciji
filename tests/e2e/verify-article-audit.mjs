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

/**
 * 合格的成文样例：要能过 auditArticle 的全部检查（考研档）。
 * 按真题的「句子配比」造——2 句短句 + 3 句长句 + 12 句中句，约 410 词。
 * 全篇同一长度的句子在 2026-11 的审计里会被判「句子长度太均匀」，这里刻意做长短交错。
 */
// 注意避开 -tion/-sion/-ment 这类名词化词：审计对名词化密度有上限（每百词 6 个）
const midSentence = (w) =>
  `Many readers still doubt the ${w} claim, although the proof behind it has grown much stronger ` +
  `over the past decade and in the years that followed.`
const longSentence = (w) =>
  `Researchers keep returning to the ${w} question, and their conclusions, which once looked settled, ` +
  `remain open to careful debate among those who follow the field closely and who read every new study with deep suspicion.`
const shortSentencesOf = () => [
  { en: `We should abandon the ${WORDS[0]} habit now.`, zh: '我们应该立刻放弃这个习惯。' },
  { en: `That is a ${WORDS[1]} question.`, zh: '那是个值得追问的问题。' },
]

const longSentences = () => {
  const out = shortSentencesOf()
  for (let i = 0; i < 3; i += 1) {
    out.push({ en: longSentence(WORDS[i + 2]), zh: `研究者反复回到 ${WORDS[i + 2]} 这个问题上。` })
  }
  for (let i = 0; i < 12; i += 1) {
    out.push({ en: midSentence(WORDS[(i + 4) % WORDS.length]), zh: '很多读者仍然质疑这个说法。' })
  }
  return out
}

/**
 * 「, which」模板化样例：其余指标全部合格，只有 6 句共用同一种非限制性定语从句。
 * 实测真实生成里出现过一篇 15 句有 6 句是 , which —— 这种"同一个模子刻的"要打回。
 */
const whichSentences = () => {
  const out = longSentences()
  let patched = 0
  for (let i = 0; i < out.length && patched < 3; i += 1) {
    if (out[i].en.includes(', which')) continue
    if (out[i].en.split(/\s+/).length < 20) continue
    out[i] = { ...out[i], en: out[i].en.replace(/\.$/, ', which matters a great deal.') }
    patched += 1
  }
  return out
}

/**
 * 末尾被截断的样例：前面完全合格，只把最后一句的句号去掉。
 * 这种残篇在真实生成里很常见（思考吃光额度，正文写一半就停），审计必须打回。
 */
const truncatedSentences = () => {
  const out = longSentences()
  const last = out[out.length - 1]
  out[out.length - 1] = { ...last, en: last.en.replace(/\.$/, '') }
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
 * @param plan (nth) => 'short' | 'long' | 'cut' | 'which'   第 n 次「成文」请求返回什么
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
                title:
                  kind === 'long'
                    ? 'AUDIT-LONG'
                    : kind === 'cut'
                      ? 'AUDIT-CUT'
                      : kind === 'which'
                        ? 'AUDIT-WHICH'
                        : 'AUDIT-SHORT',
                titleZh: '审计样例',
                sentences:
                  kind === 'long'
                    ? longSentences()
                    : kind === 'cut'
                      ? truncatedSentences()
                      : kind === 'which'
                        ? whichSentences()
                        : shortSentencesOf(),
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

  // 提纲 1 次 + 并行 4 路成文（必要时再加一次定向重写）；mock 是立即返回的，留足余量
  await sleep(3200)

  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  return { page, text, articleCalls }
}

/* ── 场景 1：四路里有一路残篇 → 择优拿到完整的那篇 ── */
{
  const { page, text, articleCalls } = await runScenario('[1] 一路残篇 → 择优拿完整篇', (n) =>
    n === 1 ? 'short' : 'long',
  )
  ok('并行了 4 路成文', articleCalls === 4, articleCalls)
  ok('最终拿到的是长的那篇', text.includes('AUDIT-LONG'), text.slice(0, 80))
  ok('合格的那篇没有标注', !text.includes('未完全达标'), text.slice(0, 80))
  await page.close()
}

/* ── 场景 2：四路都残篇 → 一次定向重写仍不行 → 交出并标注 ── */
{
  const { page, text, articleCalls } = await runScenario('[2] 全是残篇 → 重写一次后标注', () => 'short')
  ok('4 路成文 + 1 次定向重写', articleCalls === 5, articleCalls)
  ok('阅读页标了「未完全达标」', text.includes('未完全达标'), text.slice(0, 80))
  const reason = await page.evaluate(
    () => document.querySelector('[class*="shortfall"]')?.getAttribute('title') ?? '',
  )
  ok('标注里说清了是篇幅偏短', reason.includes('篇幅偏短'), reason)
  ok('文章仍然可读（有标题）', text.includes('AUDIT-SHORT'), text.slice(0, 80))
  await page.close()
}

/* ── 场景 3：一路末句被截断（其余合格）→ 择优时淘汰 ── */
{
  const { page, text, articleCalls } = await runScenario('[3] 一路末句截断 → 择优淘汰它', (n) =>
    n === 1 ? 'cut' : 'long',
  )
  ok('并行了 4 路成文', articleCalls === 4, articleCalls)
  ok('最终拿到完整的那篇', text.includes('AUDIT-LONG'), text.slice(0, 80))
  ok('残篇没有被当成品交付', !text.includes('AUDIT-CUT'), text.slice(0, 80))
  await page.close()
}

/* ── 场景 4：一路 , which 模板化（其余合格）→ 择优时淘汰 ── */
{
  const { page, text, articleCalls } = await runScenario('[4] 一路句式模板化 → 择优淘汰它', (n) =>
    n === 1 ? 'which' : 'long',
  )
  ok('并行了 4 路成文', articleCalls === 4, articleCalls)
  ok('最终拿到句式有变化的那篇', text.includes('AUDIT-LONG'), text.slice(0, 80))
  await page.close()
}

await browser.close()
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail > 0 ? 1 : 0)
