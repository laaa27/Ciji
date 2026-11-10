import puppeteer from 'puppeteer-core'

/**
 * 阅读页排版回归：句子必须连排成段，译文必须inline跟在句后。
 *
 * 先 `vite preview --port 5199`（或 dev server），再 `node tests/e2e/verify-reading-layout.mjs`
 *
 * 这套断言对治的是两个具体退化：
 * 1. 每句回到一个块级容器 → 句尾出现缺口，看不出哪几句是一段
 * 2. 译文回到另起一块 → 译文和原句被拆到两行，读的时候要来回找
 * 3. 句末标点被 inline-block 的 button 挤到单独一行
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

/** 8 句 → 正好两段，每段 4 句 */
const SENTENCES = [
  ['Walk through any city street today, and you will pass a dozen cameras before you reach the corner shop.', '今天无论你走在哪条城市街道上，到达街角小店之前都会经过十几个摄像头。'],
  ['Surveillance equipment now hangs above crossings, inside libraries and over shop doors, and most of us no longer look up at it.', '监控设备如今悬在路口上方、图书馆里、店门之上，而我们大多数人已经不再抬头看它。'],
  ['The habit formed so gradually that few people noticed the trade they were making.', '这个习惯形成得如此缓慢，以至于很少有人注意到自己做了怎样的交换。'],
  ['Convenience arrived first, and the cost came later.', '便利先到，代价随后。'],
  ['Employers argue they make considerable savings on real estate when workers shift from office to homework.', '雇主们辩称，当员工从办公室转向在家办公时，他们在房地产方面能节省大量开支。'],
  ['However, these savings result from passing costs on to workers.', '然而，这些节省是把成本转嫁给员工的结果。'],
  ['A quiet transfer of expense is easy to miss when it arrives as flexibility.', '当一笔悄然的开销以「灵活」的名义到来时，很容易被忽视。'],
  ['Cities may change fundamentally if offices remain under-utilized.', '如果办公室继续使用不足，城市可能会发生根本性的变化。'],
]

const ARTICLE = {
  id: `${today}#layout`,
  date: today,
  title: 'The Quiet Cost of Convenience',
  titleZh: '便利的隐性代价',
  sentences: SENTENCES.map(([en, zh]) => ({ en, zh })),
  targetWords: ['surveillance', 'flexibility'],
  mode: 'weak',
  level: 'kaoyan',
  model: 'glm-4-flash',
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

await page.goto(APP, { waitUntil: 'networkidle0' })
await page.evaluate((article) => {
  localStorage.clear()
  localStorage.setItem('CapacitorStorage.article:' + article.id, JSON.stringify(article))
  localStorage.setItem(
    'CapacitorStorage.article_index',
    JSON.stringify([{ id: article.id, date: article.date, title: article.title }]),
  )
}, ARTICLE)
await page.reload({ waitUntil: 'networkidle0' })
await sleep(900)

const tabs = await page.$$('nav button')
await tabs[2].click()
await sleep(1000)

const measure = () =>
  page.evaluate(() => {
    const sentences = [...document.querySelectorAll('[data-sentence]')]
    const paras = [...document.querySelectorAll('article p')].filter((p) =>
      p.querySelector('[data-sentence]'),
    )
    const lineHeight = parseFloat(getComputedStyle(sentences[0]).lineHeight)
    const rects = sentences.map((s) => s.getBoundingClientRect().toJSON())
    // 每句最后一个「词+标点」的整体
    const glue = sentences.map((s) => {
      const g = s.querySelectorAll('span[class*="glue"]')
      return g.length ? g[g.length - 1].getBoundingClientRect().toJSON() : null
    })
    return { count: sentences.length, paras: paras.map((p) => p.getBoundingClientRect().toJSON()), rects, glue, lineHeight }
  })

console.log('\n[1] 句子连排（译文关）')
const off = await measure()
ok('8 句都在', off.count === 8, off.count)
ok('切成 2 段（每段 4 句）', off.paras.length === 2, off.paras.length)

// 关键判据：下一句在这一句还结束之前就开始，说明是同一段里的连排
const overlap = off.rects[1].top < off.rects[0].bottom - 1
ok('第 2 句紧接着第 1 句（不是另起一块）', overlap, `${off.rects[0].bottom} vs ${off.rects[1].top}`)

const paraGap = off.paras[1].top - off.paras[0].bottom
ok('段与段之间才留白', paraGap > 10, paraGap)

// 句末标点不能单独占一行：末个「词+标点」的高度应该还在一行之内
const badGlue = off.glue.filter((g) => g && g.height > off.lineHeight + 2)
ok('句末标点没有被挤成单独一行', badGlue.length === 0, `${badGlue.length} 处`)

ok('没有残留的逐句块（data-break）', (await page.$('[data-break]')) === null)

console.log('\n[2] 译文 inline 跟在句后')
const zhCountBefore = await page.evaluate(() => document.querySelectorAll('[data-sentence] > span:last-of-type').length)

await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '译文')
  btn?.click()
})
await sleep(600)

const on = await page.evaluate(() => {
  const sentences = [...document.querySelectorAll('[data-sentence]')]
  const zh = sentences.map((s) => {
    const el = [...s.querySelectorAll('span')].find((x) =>
      /[\u4e00-\u9fa5]/.test(x.textContent ?? ''),
    )
    if (!el) return null
    const r = el.getBoundingClientRect().toJSON()
    return { display: getComputedStyle(el).display, top: r.top, left: r.left, bottom: r.bottom }
  })
  const rects = sentences.map((s) => s.getBoundingClientRect().toJSON())
  // 只数「装了句子的段落」，标题译文也是 p，别混进来
  const paras = [...document.querySelectorAll('article p')].filter((p) =>
    p.querySelector('[data-sentence]'),
  ).length
  return { zh, rects, paras }
})

ok('每句后面都出现了中文', on.zh.every(Boolean), on.zh.filter((z) => !z).length)
ok('中文是行内元素（不再另起一块）', on.zh.every((z) => z.display === 'inline'), on.zh[0]?.display)
ok(
  '中文落在句子的同一行里（没被推到下一行块）',
  on.zh.every((z, i) => z.top >= on.rects[i].top - 1 && z.top < on.rects[i].bottom),
  on.zh.map((z, i) => `${Math.round(z.top)}/${Math.round(on.rects[i].bottom)}`).join(' '),
)
ok('开译文不改变段落结构', on.paras === 2, on.paras)
void zhCountBefore

console.log(`\n结果：${pass} 过，${fail} 挂`)
await browser.close()
process.exit(fail > 0 ? 1 : 0)
