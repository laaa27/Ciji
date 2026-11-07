import puppeteer from 'puppeteer-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5173/'

const POOL = [
  // 放最前，保证第一天就出现在列表里，用来验证在线兜底链路
  'give up', 'in terms of', 'take into account',
  'abandon', 'inherent', 'scrutiny', 'prevalent', 'concede', 'eloquent',
  'reluctant', 'ambiguous', 'coherent', 'implicit', 'notorious', 'vulnerable',
  'meticulous', 'pragmatic', 'tentative', 'obscure', 'resilient', 'candid',
  'dubious', 'feasible', 'intricate', 'lucid', 'novel', 'profound',
]

function dateKey(offset) {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

function wave(offset, base, amp, period) {
  return Math.max(0, Math.round(base + amp * Math.sin(offset / period)))
}

function makeDay(offset) {
  const nNew = wave(offset, 9, 5, 3.1)
  const nVague = wave(offset, 3, 2.5, 2.3)
  const nForget = wave(offset, 2, 1.8, 4.7)
  const words = []
  let i = 0

  const push = (state, count, first, last) => {
    for (let k = 0; k < count; k += 1) {
      const spelling = POOL[(offset * 7 + i * 3) % POOL.length]
      i += 1
      words.push({
        vocId: `${offset}-${i}`,
        spelling,
        groups: [state],
        isNew: state === 'new',
        isFinished: true,
        order: i,
        firstResponse: first,
        lastResponse: last,
      })
    }
  }

  push('new', nNew, 'FAMILIAR', 'FAMILIAR')
  push('vague', nVague, 'VAGUE', offset % 3 === 0 ? 'FAMILIAR' : 'VAGUE')
  push('forget', nForget, 'FORGET', offset % 2 === 0 ? 'VAGUE' : 'FORGET')

  return {
    date: dateKey(offset),
    finished: words.length,
    total: words.length + wave(offset, 8, 4, 5),
    studyTimeMs: words.length * 18_000,
    collectedAt: new Date().toISOString(),
    words,
    rawCount: words.length,
    studiedCount: words.length,
  }
}

const days = Array.from({ length: 30 }, (_, i) => makeDay(i))

const SAMPLE_ARTICLE = {
  id: dateKey(0) + '#1',
  date: dateKey(0),
  title: 'The Quiet Architecture of Habit',
  titleZh: '习惯的静默建筑',
  sentences: [
    {
      en: 'We tend to imagine that character is forged in moments of crisis, when we must either concede defeat or summon an eloquence we do not possess.',
      zh: '我们总以为性格是在危机时刻锻造的——那时我们要么认输，要么迸发出自己并不具备的口才。',
    },
    {
      en: 'In reality it is built in the unremarkable hours, through small acts repeated until they become prevalent in our daily conduct.',
      zh: '实际上，它是在那些平淡无奇的时刻里建成的，靠的是重复的小动作，直到它们在日常行为中变得普遍。',
    },
    {
      en: 'Habit, scrutinized closely, is the architecture of a life; it decides what we abandon long before we notice we have abandoned it.',
      zh: '仔细观察就会发现，习惯是一生的建筑；它在我们意识到之前，早就决定了我们要放弃什么。',
    },
    {
      en: 'This is why the most consequential decisions are rarely dramatic.',
      zh: '这就是为什么最有影响的决定往往并不戏剧化。',
    },
  ],
  targetWords: ['concede', 'eloquence', 'prevalent', 'scrutiny', 'abandon'],
  mode: 'weak',
  level: 'kaoyan',
  model: 'glm-4-flash',
  createdAt: new Date().toISOString(),
}

// 往期文章，用来验证「文章库」入口
const PAST_ARTICLE = {
  ...SAMPLE_ARTICLE,
  id: dateKey(2) + '#1',
  date: dateKey(2),
  title: 'What We Owe to Silence',
  titleZh: '我们欠沉默什么',
  targetWords: ['reluctant', 'coherent'],
  createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
}

// 同一天的第二篇，验证「不覆盖、都留档」
const SECOND_TODAY = {
  ...SAMPLE_ARTICLE,
  id: dateKey(0) + '#2',
  title: 'The Cost of Certainty',
  titleZh: '确定的代价',
  targetWords: ['notorious', 'tentative'],
  createdAt: new Date(Date.now() - 3600000).toISOString(),
}

const ALL_ARTICLES = [SECOND_TODAY, SAMPLE_ARTICLE, PAST_ARTICLE]

function articleWordCount(a) {
  return a.sentences.reduce(
    (n, s) => n + (s.en.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0),
    0,
  )
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
})

const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })

// 今日页需要真实接口数据，这里用请求拦截造一份，方便在浏览器里验证交互
if ((process.argv[3] || 'history') === 'today') {
  const words = [
    ['abandon', 'vt. 放弃, 抛弃, 遗弃, 使屈从, 沉溺；n. 放任, 无拘束'],
    ['inherent', 'a. 固有的, 内在的, 与生俱来的'],
    ['scrutiny', 'n. 细看, 仔细检查, 监视, 监督'],
    ['prevalent', 'a. 普遍的, 流行的, 盛行的'],
    ['concede', 'vt. 承认, 退让；vi. 让步'],
    ['eloquent', 'a. 雄辩的, 有说服力的, 动人的'],
    ['reluctant', 'a. 不情愿的, 勉强的, 厌恶的'],
    ['ambiguous', 'a. 不明确的, 模棱两可的'],
  ]
  const today = new Date().toISOString().slice(0, 10)

  const todayItems = words.map(([spelling], i) => ({
    voc_id: 'v' + i,
    voc_spelling: spelling,
    order: i + 1,
    first_response: i < 3 ? 'FAMILIAR' : i < 6 ? 'VAGUE' : 'FORGET',
    is_new: i < 5,
    is_finished: true,
  }))

  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const url = req.url()
    const json = (body) =>
      req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: body }),
      })

    if (url.includes('get_study_progress')) {
      return json({ progress: { finished: 32, total: 150, study_time: 1452000 } })
    }
    if (url.includes('get_today_items')) {
      return json({ today_items: todayItems })
    }
    if (url.includes('query_study_records')) {
      return json({ records: [], count: 0 })
    }
    return req.continue()
  })

  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.evaluate((token) => {
    localStorage.setItem('CapacitorStorage.maimemo_token', token)
  }, 'seed-token')
  await page.reload({ waitUntil: 'networkidle0' })
  await new Promise((r) => setTimeout(r, 1500))

  // fold 参数：点顶部「释义」收起全部
  if (process.argv[4] === 'fold') {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === '释义',
      )
      if (btn) btn.click()
    })
    await new Promise((r) => setTimeout(r, 400))
  }

  // one 参数：收起后再点开第一个词
  if (process.argv[4] === 'one') {
    await page.evaluate(() => {
      const fold = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === '释义',
      )
      if (fold) fold.click()
    })
    await new Promise((r) => setTimeout(r, 300))
    await page.evaluate(() => {
      const row = document.querySelector('li[role="button"]')
      if (row) row.click()
    })
    await new Promise((r) => setTimeout(r, 400))
  }

  await page.screenshot({ path: process.argv[2] || 'today.png' })
  console.log('today preview ready, mode =', process.argv[4] || 'default')
  await browser.close()
  process.exit(0)
}

await page.goto(URL, { waitUntil: 'networkidle0' })

await page.evaluate(
  (payload) => {
    for (const d of payload.days) {
      localStorage.setItem('CapacitorStorage.day:' + d.date, JSON.stringify(d))
    }
    // 让阅读页进入「已配置」状态，并预置一篇样例文章
    if (payload.which === 'reading') {
      localStorage.setItem('CapacitorStorage.llm_key', 'seed-key-for-layout-only')

      for (const a of payload.articles) {
        localStorage.setItem('CapacitorStorage.article:' + a.id, JSON.stringify(a))
      }
      localStorage.setItem('CapacitorStorage.article_index', JSON.stringify(payload.index))
    }
  },
  {
    days,
    articles: ALL_ARTICLES,
    index: ALL_ARTICLES.map((a) => ({
      id: a.id,
      date: a.date,
      title: a.title,
      wordCount: articleWordCount(a),
      createdAt: a.createdAt,
    })),
    which: process.argv[3] || 'history',
  },
)

await page.reload({ waitUntil: 'networkidle0' })

const tabs = await page.$$('nav button')
const which = process.argv[3] || 'history'
const idx = { today: 0, history: 1, reading: 2, stats: 3, settings: 4 }[which] ?? 1
if (tabs[idx]) await tabs[idx].click()
await new Promise((r) => setTimeout(r, 700))

if (which === 'history') {
  const firstHead = await page.$('ul li button')
  if (firstHead) await firstHead.click()
  // 只等本地分片加载，在线兜底应该后补、不阻塞本地释义
  await new Promise((r) => setTimeout(r, 1200))
}

// 阅读页：传 zh 参数时顺便点开译文
if (which === 'reading' && process.argv[4] === 'zh') {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '译文',
    )
    if (btn) btn.click()
  })
  await new Promise((r) => setTimeout(r, 400))
}

// 阅读页：size 展开字号，past 展开文章库，setup 展开生成选项
if (which === 'reading' && ['size', 'past', 'setup'].includes(process.argv[4])) {
  const labelMap = { size: '字号', past: '文章库', setup: '生成' }
  const label = labelMap[process.argv[4]]
  await page.evaluate((text) => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(text),
    )
    if (btn) btn.click()
  }, label)
  await new Promise((r) => setTimeout(r, 400))
}

// 阅读页：传 word 参数时点开第一个目标词的释义卡
if (which === 'reading' && process.argv[4] === 'word') {
  await page.evaluate(() => {
    const el = document.querySelector('button[data-target="true"]')
    if (el) el.click()
  })
  await new Promise((r) => setTimeout(r, 2500))
}

// 设置页滚到底，方便看版本号
if (which === 'settings') {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.scrollHeight > d.clientHeight + 200,
    )
    if (el) el.scrollTo(0, el.scrollHeight)
  })
  await new Promise((r) => setTimeout(r, 300))
}

await page.screenshot({ path: process.argv[2] || 'history.png' })
console.log('seeded', days.length, 'days, tab =', which)
await browser.close()
