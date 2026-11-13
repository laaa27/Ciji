import puppeteer from 'puppeteer-core'

/**
 * 撇号词形（pharaoh's 这类）的还原与覆盖判定。
 *
 * 覆盖三个曾经同时出问题的点：
 *   1. `lemmaCandidates` 剥不剥所有格 —— 查词、加词库全靠它
 *   2. 文章审计的「目标词有没有用上」—— 双向展开后不该再误报
 *   3. 分词口径 —— 弯撇号 U+2019 不能被切成 `pharaoh` + `s`
 *
 * **必须跑在 dev server 上**（`npx vite --port 5199`）：脚本直接 import 源码模块，
 * preview 服务的是打包产物，没有 `/src/...` 这些路径。
 *
 *   npx vite --port 5199
 *   node tests/e2e/verify-word-forms.mjs
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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
await page.goto(APP, { waitUntil: 'domcontentloaded' })

let mods
try {
  mods = await page.evaluate(async () => {
    const article = await import('/src/domain/article.ts')
    const dict = await import('/src/lib/lemma.ts')
    const text = await import('/src/lib/text.ts')

    const one = { en: "A spacious community reading room that displays a few pieces from a pharaoh's tomb.", zh: '一间宽敞的社区阅览室，摆着几件来自法老陵墓的物件。' }
    const curly = { en: 'The pharaoh\u2019s mask was kept behind glass.', zh: '法老的棺面具被放在玻璃后面。' }
    const plain = { en: 'The mask was kept behind glass.', zh: '面具被放在玻璃后面。' }

    return {
      // ① 所有格还原
      asciiPossessive: dict.lemmaCandidates("pharaoh's"),
      curlyPossessive: dict.lemmaCandidates('pharaoh\u2019s'),
      pluralPossessive: dict.lemmaCandidates("students'"),
      // ② 覆盖判定（目标词是原形，正文写成所有格）
      covered: article.missingWords({ sentences: [one], targetWords: ['pharaoh'] }),
      // 弯撇号写法的正文
      coveredCurly: article.missingWords({ sentences: [curly], targetWords: ['pharaoh'] }),
      // 真的没写就该判缺失（防止「全判覆盖」这种假修复）
      notCovered: article.missingWords({ sentences: [plain], targetWords: ['pharaoh'] }),
      // 反向：目标词是变形，正文是原形
      coveredReversed: article.missingWords({ sentences: [plain], targetWords: ['masks'] }),
      // 短语覆盖没被这次改动打破
      phrase: article.missingWords({
        sentences: [{ en: 'The plan was meant to fail.', zh: '这个计划本就注定失败。' }],
        targetWords: ['be meant to'],
      }),
      phraseMissing: article.missingWords({
        sentences: [{ en: 'The plan failed.', zh: '计划失败了。' }],
        targetWords: ['be meant to'],
      }),
      // ③ 分词：弯撇号必须算一个词，与 ASCII 撇号一致
      asciiCount: text.countWords("a pharaoh's mask"),
      curlyCount: text.countWords('a pharaoh\u2019s mask'),
      hyphenCount: text.countWords('a well-known writer'),
      // 不该因为「减法规则」把更长的一个词当成目标词（article ≠ art）
      falsePositive: article.missingWords({
        sentences: [{ en: 'The article spread quickly.', zh: '文章传得很快。' }],
        targetWords: ['art'],
      }),
      // 复合词噪声是既有口径（news 的 -s 还原会得到 new），不在这次修复范围，
      // 记在这里免得下次误当成回归：目标 new + 正文 news 会判为已使用
      knownNoise: article.missingWords({
        sentences: [{ en: 'The news spread quickly.', zh: '消息传得很快。' }],
        targetWords: ['new'],
      }),
    }
  })
} catch (e) {
  console.log('\n无法加载源码模块。这个脚本要在 dev server 上跑：')
  console.log('  npx vite --port 5199')
  console.log('原因：' + e.message)
  await browser.close()
  process.exit(1)
}

console.log('\n[1] 所有格还原')
ok("pharaoh's → pharaoh", mods.asciiPossessive.includes('pharaoh'), mods.asciiPossessive.join(','))
ok('pharaoh’s（弯撇号）→ pharaoh', mods.curlyPossessive.includes('pharaoh'), mods.curlyPossessive.join(','))
ok("students' → students / student", mods.pluralPossessive.includes('students') && mods.pluralPossessive.includes('student'), mods.pluralPossessive.join(','))

console.log('\n[2] 文章覆盖判定')
ok('正文写了 pharaoh\'s，目标 pharaoh 判为已使用', mods.covered.length === 0, mods.covered.join(','))
ok('弯撇号写法同样判为已使用', mods.coveredCurly.length === 0, mods.coveredCurly.join(','))
ok('真的没写仍判为缺失（防假修复）', mods.notCovered.length === 1 && mods.notCovered[0] === 'pharaoh', mods.notCovered.join(','))
ok('目标词是变形、正文是原形也认（masks ← mask）', mods.coveredReversed.length === 0, mods.coveredReversed.join(','))
ok('短语覆盖没被打破（was meant to ← be meant to）', mods.phrase.length === 0, mods.phrase.join(','))
ok('短语真缺失时仍报', mods.phraseMissing.length === 1, mods.phraseMissing.join(','))
ok('不会把 article 误判成 art', mods.falsePositive.length === 1, mods.falsePositive.join(','))
ok('已知噪声不变（news 的 -s 会还原出 new，属既有口径）', mods.knownNoise.length === 0, mods.knownNoise.join(','))

console.log('\n[3] 分词口径')
ok("ASCII 撇号算一个词", mods.asciiCount === 3, String(mods.asciiCount))
ok('弯撇号算一个词（曾经被拆成 4 个）', mods.curlyCount === 3, String(mods.curlyCount))
ok('连字符算一个词', mods.hyphenCount === 3, String(mods.hyphenCount))

/*
 * [4] 变形回归表。
 *
 * 只断言「该有的候选在不在」是不够的 —— 之前的两个线上 bug 都是**多了**一个候选：
 * sites 多出 sit、files 多出 fil，而它们恰好是真实单词，于是挤掉了正确答案。
 * 所以每行同时写「必须有」和「不能有」，谁再加规则都得先过这张表。
 */
const TABLE = [
  { input: 'sites', need: ['site'], forbid: ['sit'] },
  { input: 'files', need: ['file'], forbid: ['fil'] },
  { input: 'notes', need: ['note'], forbid: ['not'] },
  { input: 'uses', need: ['use'], forbid: [] },
  { input: 'boxes', need: ['box'], forbid: [] },
  { input: 'watches', need: ['watch'], forbid: [] },
  { input: 'dishes', need: ['dish'], forbid: [] },
  { input: 'studies', need: ['study'], forbid: ['studi'] },
  { input: 'filing', need: ['file'], forbid: [] },
  { input: 'filed', need: ['file'], forbid: [] },
  { input: 'running', need: ['run'], forbid: [] },
  { input: 'making', need: ['make'], forbid: [] },
  { input: 'asking', need: ['ask'], forbid: [] },
  { input: 'stopped', need: ['stop'], forbid: [] },
  { input: 'analyses', need: ['analysis'], forbid: [] },
  { input: 'leaves', need: ['leaf'], forbid: [] },
  { input: "pharaoh's", need: ['pharaoh'], forbid: [] },
]

/** 顺序也断言：原词第一；「更像原形」的那个必须排前面 */
const ORDER = [
  { input: 'uses', before: 'use', after: 'us' },
  { input: 'filing', before: 'file', after: 'fil' },
  { input: 'filed', before: 'file', after: 'fil' },
]

const table = await page.evaluate(
  async ({ TABLE, ORDER }) => {
    const dict = await import('/src/lib/lemma.ts')
    const memo = await import('/src/domain/memo.ts')

    const rows = TABLE.map((c) => ({ ...c, cands: dict.lemmaCandidates(c.input) }))
    const orders = ORDER.map((o) => {
      const cands = dict.lemmaCandidates(o.input)
      return { input: o.input, cands, mustBefore: o.before, mustAfter: o.after, iBefore: cands.indexOf(o.before), iAfter: cands.indexOf(o.after) }
    })

    // 墨墨查询的挑选用例：服务端把 sit 排在 site 前面，也必须选 site
    const pickWrongOrder = memo.pickByCandidateOrder(
      [{ spelling: 'sit' }, { spelling: 'site' }],
      dict.lemmaCandidates('sites'),
      (x) => x.spelling,
    )
    // 原词在列表里时，必须优先原词（不能因为 file 更短就先认 file）
    const pickExactFirst = memo.pickByCandidateOrder(
      [{ spelling: 'file' }, { spelling: 'filing' }],
      dict.lemmaCandidates('filing'),
      (x) => x.spelling,
    )
    // 完全没命中时返回 null，不能瞎挑一个
    const pickNone = memo.pickByCandidateOrder(
      [{ spelling: 'sit' }],
      dict.lemmaCandidates('sites'),
      (x) => x.spelling,
    )

    return { rows, orders, pickWrongOrder, pickExactFirst, pickNone }
  },
  { TABLE, ORDER },
)

console.log('\n[4] 变形回归表（必须有 / 不能有）')
for (const r of table.rows) {
  const missing = r.need.filter((w) => !r.cands.includes(w))
  const bad = r.forbid.filter((w) => r.cands.includes(w))
  ok(
    `${r.input} → ${r.need.join(' / ')}`,
    missing.length === 0 && bad.length === 0,
    `候选 ${r.cands.join('|')}${missing.length ? ` 缺 ${missing.join(',')}` : ''}${bad.length ? ` 多了 ${bad.join(',')}` : ''}`,
  )
}

console.log('\n[5] 顺序：原词第一、可信的原形排在毒候选前面')
for (const r of table.rows) {
  ok(`${r.input} 原词排第一`, r.cands[0] === r.input, r.cands.join('|'))
}
for (const o of table.orders) {
  ok(
    `${o.input}：${o.mustBefore} 在 ${o.mustAfter} 之前`,
    o.iBefore >= 0 && (o.iAfter < 0 || o.iBefore < o.iAfter),
    o.cands.join('|'),
  )
}

console.log('\n[6] 墨墨查询的挑选顺序')
ok('服务端把 sit 排前面也选 site', table.pickWrongOrder?.spelling === 'site', JSON.stringify(table.pickWrongOrder))
ok('原词 filing 优先于 file', table.pickExactFirst?.spelling === 'filing', JSON.stringify(table.pickExactFirst))
ok('只返回 sit 时不硬凑（判为没查到）', table.pickNone === null, JSON.stringify(table.pickNone))

console.log(`\n结果：${pass} 过，${fail} 挂`)
await browser.close()
process.exit(fail)
