import puppeteer from 'puppeteer-core'

/**
 * 阅读页 + 生成页的浏览器验证。
 *
 * 覆盖：
 *   1. 生成页只认「某一天」的词，历史词不混进来
 *   2. 三类词（忘记/模糊/新学）可任意组合，取消一类 → 对应词掉到「不使用」
 *   3. 每个词可单独勾选/取消，两组数量实时对得上
 *   4. 当天已用过的词默认不出现，开关打开后出现并标注
 *   5. 难度里没有雅思；词数上限超了给提示
 *   6. 生成在后台继续，切走也会弹 toast；切回来状态与滚动位置都在
 *   7. 文章库：入口、排序、打开、两步删除
 *
 * 先 `npx vite --port 5199`，再 `node tests/e2e/test-reading.mjs`
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

const t = (ms) => new Promise((r) => setTimeout(r, ms))

/** 今天的词：20 个，覆盖三类（每 4 个里 1 个新学，其余模糊/忘记交替） */
const TODAY_WORDS = [
  'abandon', 'scrutiny', 'coherent', 'eloquent', 'prevalent', 'concede', 'reluctant',
  'ambiguous', 'implicit', 'notorious', 'vulnerable', 'meticulous', 'pragmatic',
  'tentative', 'obscure', 'resilient', 'candid', 'dubious', 'feasible', 'intricate',
]
const todayItems = TODAY_WORDS.map((w, i) => ({
  voc_id: `v-${i}`,
  voc_spelling: w,
  first_response: i % 4 === 0 ? 'FAMILIAR' : i % 3 === 0 ? 'VAGUE' : 'FORGET',
  is_new: i % 4 === 0,
  is_finished: true,
  order: i,
}))

/** 昨天：一个绝不会出现在今天的标记词，用来验证「只认所选日期」 */
const YESTERDAY_MARK = 'archaism'
const yesterdaySnapshot = {
  date: '2026-11-07',
  finished: 2,
  total: 2,
  studyTimeMs: 600000,
  words: [
    { vocId: 'y-1', spelling: YESTERDAY_MARK, groups: ['forget'], isNew: false, firstResponse: 'FORGET', isFinished: true, order: 0 },
    { vocId: 'y-2', spelling: 'bedrock', groups: ['new'], isNew: true, firstResponse: 'FAMILIAR', isFinished: true, order: 1 },
  ],
  collectedAt: '2026-11-07T10:00:00.000Z',
  rawCount: 2,
  studiedCount: 2,
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

let llmCalls = 0
let articleNo = 0

// 墨墨侧的可变状态：哪些词在计划里、哪些词库里有
const inPlan = new Set(['coherent'])
// 词库只收原形：shipments / studying 这种变形不该命中，否则测不出还原
const knownVocab = new Set([...TODAY_WORDS, 'shipment', 'study'].filter((w) => w !== 'scrutiny'))
const notInVocab = new Set(['scrutiny'])
const added = []
const memoCalls = { records: 0, voc: 0, advance: 0 }
const makeRecord = (spelling) => ({
  voc_id: `id-${spelling}`,
  voc_spelling: spelling,
  add_date: '2026-11-01T02:00:00.000Z',
  last_study_date: '2026-11-07T02:00:00.000Z',
  next_study_date: '2026-11-10T00:00:00.000Z',
  last_response: 'VAGUE',
  study_count: 4,
  tags: 'STICKING',
})

await page.setRequestInterception(true)
page.on('request', (req) => {
  const url = req.url()

  if (url.includes('/open/')) {
    const json = (body) =>
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: body }) })
    if (url.includes('get_study_progress')) return json({ progress: { finished: 20, total: 180, study_time: 900000 } })
    if (url.includes('get_today_items')) return json({ today_items: todayItems })

    if (url.includes('query_study_records')) {
      memoCalls.records += 1
      const body = JSON.parse(req.postData() ?? '{}')
      const asked = body.spellings ?? []
      const records = asked.filter((w) => inPlan.has(String(w).toLowerCase())).map(makeRecord)
      return json({ records, count: records.length })
    }

    if (url.includes('/vocabulary/query')) {
      memoCalls.voc += 1
      const body = JSON.parse(req.postData() ?? '{}')
      const asked = body.spellings ?? []
      const voc = asked
        .filter((w) => {
          const k = String(w).toLowerCase()
          return !notInVocab.has(k) && knownVocab.has(k)
        })
        .map((w) => ({ id: `id-${w}`, spelling: w }))
      return json({ voc })
    }

    if (url.includes('/study/advance_study')) {
      memoCalls.advance += 1
      return json({ advanced_count: 1 })
    }

    if (url.includes('/study/add_words')) {
      const body = JSON.parse(req.postData() ?? '{}')
      const ids = (body.words ?? []).map((x) => String(x.id))
      let count = 0
      for (const id of ids) {
        const spelling = id.replace(/^id-/, '').toLowerCase()
        if (!inPlan.has(spelling)) {
          inPlan.add(spelling)
          added.push(spelling)
          count += 1
        }
      }
      return json({ added_count: count })
    }

    return json({ records: [], count: 0 })
  }

  if (url.includes('/__llm')) {
    llmCalls += 1
    // 不能用奇偶判断：生成不合格会重新生成，一次生成可能触发 2 次成文请求
    const isOutline = !(req.postData() ?? '').includes('必须包含的单词')
    const payload = isOutline
      ? {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  topic: '习惯为什么比意志力可靠',
                  paragraphs: [
                    { idea: '开篇', link: '开篇', words: TODAY_WORDS.slice(0, 5) },
                    { idea: '论证', link: '递进', words: TODAY_WORDS.slice(5, 12) },
                    { idea: '收束', link: '转折', words: TODAY_WORDS.slice(12) },
                  ],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }
      : (() => {
          articleNo += 1
          const sentences = Array.from({ length: 42 }, (_, i) => ({
            en: `Sentence ${i + 1} mentions ${TODAY_WORDS[i % TODAY_WORDS.length]} in a calm, deliberate way.`,
            zh: `第 ${i + 1} 句用平静的方式提到了 ${TODAY_WORDS[i % TODAY_WORDS.length]}。`,
          }))
          // 词形还原用：复数与 -ing
          sentences.push({
            en: 'Shipments and studying keep the argument moving.',
            zh: '出货与研究让论证继续推进。',
          })
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
    }, 350)
    return
  }

  return req.continue()
})

await page.goto(APP, { waitUntil: 'networkidle0' })

await page.evaluate((snapshot) => {
  localStorage.clear()
  localStorage.setItem('CapacitorStorage.maimemo_token', 'seed')
  localStorage.setItem('CapacitorStorage.day:' + snapshot.date, JSON.stringify(snapshot))
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
}, yesterdaySnapshot)

await page.reload({ waitUntil: 'networkidle0' })
await t(600)

const tabs = await page.$$('nav button')
const bodyText = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))

const clickText = (text) =>
  page.evaluate((needle) => {
    const want = needle.replace(/\s+/g, '')
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.replace(/\s+/g, '') === want,
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, text)

const clickIncludes = (text) =>
  page.evaluate((needle) => {
    const want = needle.replace(/\s+/g, '')
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.replace(/\s+/g, '').includes(want),
    )
    if (btn) btn.click()
    return Boolean(btn)
  }, text)

/** 某个词在词表里的勾选状态（读 data-on） */
const wordState = (spelling) =>
  page.evaluate((w) => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.includes(w) && b.dataset.on !== undefined,
    )
    return btn ? btn.dataset.on : null
  }, spelling)

/** 「将使用 / 不使用」两组各有多少个词 */
const groupCounts = () =>
  page.evaluate(() => {
    const heads = [...document.querySelectorAll('h2')]
    const pick = (label) => {
      const h = heads.find((x) => x.textContent?.includes(label))
      if (!h) return 0
      const ul = h.parentElement?.querySelector('ul')
      return ul ? ul.querySelectorAll('li').length : 0
    }
    return { chosen: pick('将使用'), rest: pick('不使用') }
  })

const scrollTo = async (y) => {
  await page.evaluate((target) => {
    const scroller = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 100)
    if (scroller) scroller.scrollTop = target
  }, y)
  await t(250)
}

console.log('\n[1] 进入生成页：只认所选日期的词')
await tabs[2].click()
await t(600)
await clickText('生成')
await t(800)

let text = await bodyText()
ok('进入了生成文章页', text.includes('生成文章'), text.slice(0, 60))
ok('默认选中今天', text.includes('今天'))
ok('今天没有历史词混进来', !text.includes(YESTERDAY_MARK), YESTERDAY_MARK)

const kinds = await page.evaluate(() =>
  ['忘记', '模糊', '新学'].map((k) => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.textContent?.includes(k) && x.dataset.on !== undefined,
    )
    return { k, on: b?.dataset.on ?? null }
  }),
)
ok('三个类型默认全选', kinds.every((x) => x.on === 'true'), JSON.stringify(kinds))

let counts = await groupCounts()
ok('默认全部进入「将使用」', counts.chosen > 0 && counts.rest === 0, JSON.stringify(counts))

console.log('\n[2] 取消「新学」：对应词掉到「不使用」')
await clickIncludes('新学')
await t(450)
const afterKind = await groupCounts()
ok('将使用变少', afterKind.chosen < counts.chosen, JSON.stringify([counts, afterKind]))
ok('不使用出现词', afterKind.rest > 0, JSON.stringify(afterKind))
ok('新学的词变成未选', (await wordState('abandon')) === 'false', await wordState('abandon'))

await clickIncludes('新学')
await t(450)
ok('勾回来恢复', (await groupCounts()).rest === 0)

console.log('\n[3] 逐词切换')
const before = await groupCounts()
ok('scrutiny 默认选中', (await wordState('scrutiny')) === 'true')
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.includes('scrutiny') && b.dataset.on !== undefined,
  )
  btn?.click()
})
await t(400)
const after = await groupCounts()
ok(
  '取消后移到「不使用」',
  after.chosen === before.chosen - 1 && after.rest === before.rest + 1,
  JSON.stringify([before, after]),
)
ok('状态同步为未选', (await wordState('scrutiny')) === 'false')

console.log('\n[4] 换到昨天：只出现昨天的词')
await clickText('11月7日')
await t(700)
text = await bodyText()
ok('出现昨天的标记词', text.includes(YESTERDAY_MARK), text.slice(0, 80))

await clickText('今天')
await t(700)

console.log('\n[5] 难度与词数上限')
const levels = await page.evaluate(() =>
  ['四级', '六级', '考研', '雅思'].map((l) => ({
    l,
    has: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === l),
  })),
)
ok('有四级/六级/考研', levels.slice(0, 3).every((x) => x.has), JSON.stringify(levels))
ok('没有雅思', levels[3].has === false)

// 难度与词数上限要排在词表之前
const order = await page.evaluate(() => {
  const all = [...document.querySelectorAll('h2')].map((h) => h.textContent?.trim() ?? '')
  const idx = (label) => all.findIndex((x) => x.includes(label))
  return { level: idx('难度'), limit: idx('词数上限'), chosen: idx('将使用') }
})
ok(
  '难度与词数上限在词表上方',
  order.level >= 0 && order.limit > order.level && order.chosen > order.limit,
  JSON.stringify(order),
)

await clickText('10')
await t(450)
text = await bodyText()
ok('超过上限时给提示', /超过上限/.test(text), text.match(/选了[^。]{0,40}/)?.[0])

console.log('\n[6] 生成 → 回到阅读页')
await clickText('25')
await t(300)
await clickIncludes('个词生成')
await t(2600)
text = await bodyText()
ok('文章已生成', text.includes('The Weight of Habit 1'), text.slice(0, 80))
ok('生成页已关闭', !text.includes('哪一天'))

console.log('\n[7] 已用过的词默认不出现，开关可展开')
await clickText('生成')
await t(800)
text = await bodyText()
// 整页文本里提示语本身就含「已用」，要看词行是否真的没渲染
ok('默认一个词都不列（全用过了）', (await groupCounts()).chosen === 0 && (await wordState('abandon')) === null)
ok('给出原因与开关', text.includes('这天的词都用') && text.includes('包含这天已经用过的词'), text.slice(0, 140))

const clickUsedToggle = () =>
  page.evaluate(() => {
    const label = [...document.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('包含这天已经用过的词'),
    )
    const input = label?.querySelector('input[type="checkbox"]')
    if (input) {
      input.click()
      return true
    }
    return false
  })
ok('点得到开关', await clickUsedToggle())
await t(600)
ok('打开后词回来了且默认不勾', (await wordState('abandon')) === 'false', await wordState('abandon'))
ok('带「已用」标记', (await bodyText()).includes('已用'), (await bodyText()).slice(0, 160))

await clickIncludes('返回')
await t(700)

console.log('\n[8] 切栏目后阅读状态与滚动位置保留')
await clickText('译文')
await t(350)
ok('译文已开', (await bodyText()).includes('第 1 句用平静'))

await scrollTo(420)
const y1 = await page.evaluate(() => {
  const s = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 100)
  return Math.round(s?.scrollTop ?? -1)
})
await tabs[0].click()
await t(400)
await tabs[2].click()
await t(500)
ok('文章还在', (await bodyText()).includes('The Weight of Habit 1'))
ok('译文仍开着', (await bodyText()).includes('第 1 句用平静'))
const y2 = await page.evaluate(() => {
  const s = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 100)
  return Math.round(s?.scrollTop ?? -1)
})
ok('滚动位置恢复', Math.abs(y2 - y1) <= 2, `${y1} → ${y2}`)

console.log('\n[9] 顶部工具条吸顶')
await scrollTo(700)
const head = await page.evaluate(() => {
  const el = [...document.querySelectorAll('header')].find((h) => h.textContent?.includes('阅读'))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: Math.round(r.top), stuck: el.dataset.stuck }
})
// 负 margin 抵消内边距后，边框盒顶边落在 30-8=22，但文字仍然从 30 开始
ok('标题吸在安全区下沿', head && head.top >= 18 && head.top <= 32, head?.top)
ok('标记为已贴住', head?.stuck === 'true', head?.stuck)

console.log('\n[10] 生成中切走：后台继续并弹提示')
await clickText('生成')
await t(800)
// 上一轮把 20 个词都用掉了，先展开已用词再手动挑几个
await clickUsedToggle()
await t(600)
for (const w of ['abandon', 'scrutiny', 'coherent']) {
  await page.evaluate((spelling) => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.includes(spelling) && b.dataset.on !== undefined,
    )
    btn?.click()
  }, w)
  await t(150)
}
ok('手动挑了 3 个词', (await groupCounts()).chosen === 3, JSON.stringify(await groupCounts()))
await clickIncludes('个词生成')
await t(120)
await tabs[0].click()
await t(2800)
const toast = await page.evaluate(() => document.querySelector('[role="status"]')?.textContent?.trim() ?? null)
ok('切走后弹提示', toast === '文章生成好了', toast)

await tabs[2].click()
await t(600)
ok('新文章已就位', (await bodyText()).includes('The Weight of Habit 2'), (await bodyText()).slice(0, 80))

console.log('\n[11] 文章库：打开、删除')
await clickText('文章库')
await t(700)
text = await bodyText()
ok('进入文章库', text.includes('2 篇'), text.slice(0, 40))
ok('倒序排列', text.indexOf('The Weight of Habit 2') < text.indexOf('The Weight of Habit 1'))

const removeRow = (title) =>
  page.evaluate((tt) => {
    const li = [...document.querySelectorAll('li')].find((x) => x.textContent?.includes(tt))
    const btn = [...(li?.querySelectorAll('button') ?? [])].find((b) =>
      ['删除', '确认'].includes(b.textContent?.trim() ?? ''),
    )
    const label = btn?.textContent?.trim() ?? null
    btn?.click()
    return label
  }, title)

ok('第一次点删除变确认', (await removeRow('The Weight of Habit 1')) === '删除')
await t(300)
ok('第二次真删', (await removeRow('The Weight of Habit 1')) === '确认')
await t(700)
ok('只剩 1 篇', (await bodyText()).includes('1 篇'))

console.log('\n[12] 点词看墨墨状态、加入学习计划')
// 上一段停在文章库里，先退回阅读页
await clickIncludes('返回')
await t(700)

// 点词才查：文章已经显示出来了，此时不该有任何墨墨查询
const beforeCalls = { ...memoCalls }
await t(700)
ok(
  '打开文章不为全文批量查墨墨',
  memoCalls.records === beforeCalls.records && memoCalls.voc === beforeCalls.voc,
  JSON.stringify([beforeCalls, memoCalls]),
)
const clickWord = (spelling) =>
  page.evaluate((w) => {
    const btns = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === w && b.dataset.target !== undefined,
    )
    btns[0]?.click()
    return btns.length > 0
  }, spelling)

const sheetText = () =>
  page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText.replace(/\s+/g, ' ') ?? '')

const closeSheet = async () => {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === '关闭',
    )
    btn?.click()
  })
  await t(350)
}

// 已在计划里的词
ok('点到文章里的词', await clickWord('coherent'))
await t(900)
let sheet = await sheetText()
ok('显示已在学习计划', sheet.includes('已在学习计划'), sheet.slice(0, 80))
ok('显示背过次数与上次反馈', sheet.includes('背过 4 次') && sheet.includes('模糊'), sheet)
ok('显示下次复习与标签', sheet.includes('下次复习') && sheet.includes('顽固词'), sheet)

const clickDialogButton = (label) =>
  page.evaluate((text) => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === text,
    )
    btn?.click()
    return Boolean(btn)
  }, label)

ok('已在计划的词有「提前复习」按钮', await clickDialogButton('提前复习'))
await t(800)
ok('发出了提前复习请求', memoCalls.advance === 1, memoCalls.advance)
ok('给出提前结果', (await sheetText()).includes('已提前'), await sheetText())
await closeSheet()

// 词库里有、没加入 → 两步确认后加入
ok('点到一个未加入的词', await clickWord('abandon'))
await t(900)
sheet = await sheetText()
ok('显示还没加入', sheet.includes('还没加入墨墨'), sheet.slice(0, 80))

const clickAdd = () =>
  page.evaluate(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
      ['加入学习计划', '确认加入？'].includes(b.textContent?.trim() ?? ''),
    )
    const label = btn?.textContent?.trim() ?? null
    btn?.click()
    return label
  })

ok('第一次点是「加入学习计划」', (await clickAdd()) === '加入学习计划')
await t(300)
ok('变成确认态', (await sheetText()).includes('确认加入'), await sheetText())

ok('第二次点发出加入', (await clickAdd()) === '确认加入？')
await t(900)
ok('服务端收到了加词请求', added.includes('abandon'), JSON.stringify(added))
sheet = await sheetText()
ok('加入后立刻显示已在计划', sheet.includes('已在学习计划'), sheet.slice(0, 100))
ok('给出成功提示', sheet.includes('已加入学习计划'), sheet.slice(0, 120))
await closeSheet()

// 词形还原：复数 / -ing 都要能落到原形
ok('点到复数形式', await clickWord('Shipments'))
await t(900)
sheet = await sheetText()
ok('复数能落到原形 shipment', sheet.includes('词库里是 shipment'), sheet.slice(0, 120))

const hasFormChip = (form) =>
  page.evaluate(
    (f) => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent?.trim() === f),
    form,
  )
ok('列出同族变形', await hasFormChip('shipment'), await sheetText())
ok('点词触发了一次查询', memoCalls.records > beforeCalls.records, JSON.stringify(memoCalls))

await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[role="dialog"] button')].find(
    (b) => b.textContent?.trim() === 'shipment',
  )
  btn?.click()
})
await t(800)
ok('点变形标签切换了词', (await sheetText()).startsWith('shipment'), (await sheetText()).slice(0, 40))
// 切到原形之后家族不能消失（否则就回不去了）
ok('切到原形后仍能选回复数', await hasFormChip('shipments'), await sheetText())
ok('原形自身也在标签里', await hasFormChip('shipment'), await sheetText())
await closeSheet()

ok('点到 -ing 形式', await clickWord('studying'))
await t(900)
sheet = await sheetText()
ok('-ing 能落到原形 study', sheet.includes('词库里是 study'), sheet.slice(0, 120))
await closeSheet()

// 词库里没有的词
ok('点到一个词库没有的词', await clickWord('scrutiny'))
await t(900)
sheet = await sheetText()
ok('说明加不进去', sheet.includes('墨墨词库里没有这个词'), sheet.slice(0, 100))
await closeSheet()

console.log('\n[13] 无 JS 报错')
ok('页面干净', errors.length === 0, errors.slice(0, 3))

console.log(`\n通过 ${pass} / 失败 ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
