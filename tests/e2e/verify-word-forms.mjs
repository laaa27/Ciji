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
    const dict = await import('/src/data/dict.ts')
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

console.log(`\n结果：${pass} 过，${fail} 挂`)
await browser.close()
process.exit(fail)
