import puppeteer from 'puppeteer-core'

/**
 * 批量查词的额度与缓存行为。
 *
 * 对治两个真实 bug：
 *   1. 缺词超过 40 个时，`aiGlossBatch` 切 20、MyMemory 再切 20，剩下的词
 *      **既不查也不报**，调用方拿到的结果里直接消失（导出几千词时必然踩到）
 *   2. 批量路径完全不读释义缓存 —— 每次刷新/导出都把同一批词重新发一遍
 *
 * 这里不配大模型（AI 层直接返回空），所以测的是「缓存 + MyMemory」这两层；
 * AI 分批循环（每批 20、总量 60）由代码保证，同样的结构。
 *
 * **必须跑在 dev server 上**（`npx vite --port 5199`）：脚本直接 import 源码模块。
 *   node tests/e2e/verify-lookup-batch.mjs
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

// MyMemory 打桩：数调用次数，并给一个可辨认的释义
await page.evaluateOnNewDocument(() => {
  window.__mm = 0
  const real = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('mymemory.translated.net')) {
      window.__mm += 1
      const q = new URL(url).searchParams.get('q')
      return new Response(
        JSON.stringify({ responseData: { translatedText: `释义:${q}` } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return real(input, init)
  }
})

await page.goto(APP, { waitUntil: 'domcontentloaded' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'domcontentloaded' })

/** 造不在本地词典里的词（首字母 z 的分片里没有这些） */
const fakeWords = (n, tag) => Array.from({ length: n }, (_, i) => `zzq${tag}${i}x`)

const run = async (words, opts) =>
  page.evaluate(
    async ({ list, options }) => {
      const dict = await import('/src/domain/lookup.ts')
      const res = await dict.lookupWords(list, options)
      return { size: res.glosses.size, skipped: res.skipped.length, mm: window.__mm }
    },
    { list: words, options: opts },
  )

console.log('\n[1] 50 个缺词：以前只查到 40 个，剩下 10 个静默消失')
const r1 = await run(fakeWords(50, 'a'))
ok('50 个词全部拿到释义', r1.size === 50, `只拿到 ${r1.size} 个`)
ok('没有词被静默丢弃', r1.skipped === 0, `skipped=${r1.skipped}`)
ok('MyMemory 确实被调了 50 次', r1.mm === 50, `mm=${r1.mm}`)

console.log('\n[2] 再查同一批：必须走缓存，不再发请求')
const r2 = await run(fakeWords(50, 'a'))
ok('结果一样', r2.size === 50, `只拿到 ${r2.size} 个`)
ok('请求数没有增加（缓存生效）', r2.mm === r1.mm, `${r1.mm} → ${r2.mm}`)

console.log('\n[3] 200 个缺词：60 个查到，140 个如实报出（不再静默）')
const r3 = await run(fakeWords(200, 'b'))
ok('查到 60 个（MyMemory 单次上限）', r3.size === 60, `拿到 ${r3.size} 个`)
ok('剩下 140 个进了 skipped', r3.skipped === 140, `skipped=${r3.skipped}`)

console.log('\n[3b] 导出这类长任务：允许调用方关掉联网')
const r3b = await run(fakeWords(30, 'c'), { allowOnline: false })
ok('一个都不联网', r3b.mm === r3.mm, `${r3.mm} → ${r3b.mm}`)
ok('也没查到的词不算 skipped（本来就没打算查）', r3b.size === 0 && r3b.skipped === 0, JSON.stringify(r3b))

console.log('\n[4] 本地词典命中不联网')
const localRes = await page.evaluate(async () => {
  const dict = await import('/src/domain/lookup.ts')
  const before = window.__mm
  const res = await dict.lookupWords(['abandon', 'site', 'sites'])
  return { before, after: window.__mm, size: res.glosses.size, sites: res.glosses.get('sites') }
})
ok('三个词都查到', localRes.size === 3, String(localRes.size))
ok('没发在线请求', localRes.after === localRes.before, `${localRes.before} → ${localRes.after}`)
ok('sites 用的是 site 的释义（不是 sit）', /场所|位置/.test(localRes.sites ?? ''), localRes.sites)

console.log('\n[5] 单条查词与批量走同一条链（开关已删除）')
const single = await page.evaluate(async () => {
  const dict = await import('/src/domain/lookup.ts')
  const before = window.__mm
  const r = await dict.lookupOneDetailed('zzqsingleword')
  return { gloss: r.gloss, mm: window.__mm - before }
})
ok('单条也能落到 MyMemory', single.mm === 1 && Boolean(single.gloss), JSON.stringify(single))

await browser.close()
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail > 0 ? 1 : 0)
