/**
 * 生成文章 + 与真题语料对比（命令行工具，不进 app 包）。
 *
 * 为什么需要它：app 里的提示词质量，只能靠「生成一篇 → 和真题比指标」来验证。
 * 这个脚本和 app 共用 `src/domain/prompts.ts`，所以测出来的结论对 app 有效。
 *
 * 三种模式：
 *   1) 只量语料（不调模型）：
 *        node --experimental-strip-types scripts/gen-article.mjs --measure
 *   2) 只看提示词（不调模型）：
 *        node --experimental-strip-types scripts/gen-article.mjs --level kaoyan --words abandon,scrutiny --dry-run
 *   3) 真的生成一篇并对比：
 *        LLM_API_KEY=sk-xxx LLM_BASE_URL=https://api.deepseek.com LLM_MODEL=deepseek-chat \
 *        node --experimental-strip-types scripts/gen-article.mjs --level kaoyan --words abandon,scrutiny
 *
 * 语料目录：`scripts/corpus/<level>.txt`，多篇之间用单独一行 `---` 分隔。
 * 级别名：cet4 / cet6 / kaoyan（英语一）/ kaoyan2（英语二）。
 *
 * 环境变量：
 *   LLM_API_KEY   必填（生成模式）
 *   LLM_BASE_URL  默认 https://api.openai.com
 *   LLM_MODEL     默认 gpt-4o-mini
 *   LLM_PROTOCOL  openai | anthropic，默认 openai
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  buildArticleMessages,
  buildOutlineMessages,
  LEVEL_SPEC,
  PROMPT_VERSION,
  GENRE_LABEL,
  pickGenre,
} from '../src/domain/prompts.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS_DIR = join(HERE, 'corpus')
const OUT_DIR = join(HERE, 'out')
/** 密钥放这里（已 gitignore）：scripts/llm.config.json */
const CONFIG_FILE = join(HERE, 'llm.config.json')

const LEVELS = ['cet4', 'cet6', 'kaoyan']
/** 每个级别至少要几篇真题才认为均值可信 —— 用户要求 10 篇 */
const MIN_SAMPLES = 10

/* ── 命令行 ─────────────────────────────── */

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? '') : fallback
}
const has = (name) => argv.includes(`--${name}`)

const level = arg('level', 'kaoyan')

/** 优先级：命令行/env > scripts/llm.config.json > 默认值 */
function loadConfig() {
  let file = {}
  if (existsSync(CONFIG_FILE)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
    } catch (e) {
      throw new Error(`scripts/llm.config.json 不是合法 JSON：${e.message}`)
    }
  }
  return {
    apiKey: process.env.LLM_API_KEY || file.apiKey || '',
    baseUrl: (process.env.LLM_BASE_URL || file.baseUrl || 'https://api.openai.com').replace(/\/+$/, ''),
    model: arg('model') || process.env.LLM_MODEL || file.model || 'deepseek-chat',
    protocol: process.env.LLM_PROTOCOL || file.protocol || 'openai',
    // 思考档位：disabled（关）/ low（低强度）/ default（模型默认）
    // 实测：关掉最稳（6s）；low 只是把思考量减半，仍可能吃光预算
    thinking: has('thinking') ? arg('thinking') : file.thinking || 'default',
  }
}
/** 文体：不指定就按该档配额抽签 */
const genreArg = arg('genre')
const wordsArg = arg('words')
const wordsFile = arg('words-file')
const runs = Number(arg('runs', '1'))
/** 成文温度：app 里是 0.85；实验发现调低能显著提高篇幅达标率 */
const temp = Number(arg('temp', '0.85'))
const words = (
  wordsArg
    ? wordsArg.split(/[,，\s]+/)
    : wordsFile
      ? readFileSync(wordsFile, 'utf-8').split(/[,，\s]+/)
      : []
).filter(Boolean)

/* ── 指标（与 python 版同一套口径） ───────── */

const SUBORDINATORS = new Set(
  'which that who whom whose where when while although though because since if unless whereas whether before after until once provided than as'.split(
    ' ',
  ),
)
const NOMINAL = /[a-z]+(tion|sion|ment|ance|ence|ity|ness|ism|ship)$/

const wordsOf = (s) => s.match(/[A-Za-z][A-Za-z'-]*/g) ?? []

function splitSentences(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).filter((s) => s.trim().length > 0)
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const sd = (xs) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const i = s.length >> 1
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2
}

function measure(text) {
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim())
  const sentences = splitSentences(text)
  const tokens = wordsOf(text).map((w) => w.toLowerCase())
  const lens = sentences.map((s) => wordsOf(s).length)
  const n = tokens.length
  const pct = (k) => Math.round((100 * k) / n) / 1

  return {
    words: n,
    sentences: sentences.length,
    paragraphs: paras.length,
    avg: Math.round((n / sentences.length) * 10) / 10,
    median: median(lens),
    max: Math.max(...lens),
    p90: [...lens].sort((a, b) => a - b)[Math.floor(lens.length * 0.9)],
    over30: Math.round((100 * lens.filter((l) => l > 30).length) / lens.length),
    over40: Math.round((100 * lens.filter((l) => l > 40).length) / lens.length),
    sub: pct(tokens.filter((w) => SUBORDINATORS.has(w)).length),
    nomi: pct(tokens.filter((w) => NOMINAL.test(w)).length),
    passive: Math.round((100 * (text.match(/\b(is|are|was|were|been|being|be)\s+(\w+ed|\w+en)\b/gi)?.length ?? 0)) / n * 10) / 10,
  }
}

/* ── 语料 ───────────────────────────────── */

function loadCorpus(level) {
  const file = join(CORPUS_DIR, `${level}.txt`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .split(/\n---\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

function corpusStats(level) {
  const texts = loadCorpus(level)
  const rows = texts.map(measure)
  const avgLens = rows.map((r) => r.avg)
  const s = sd(avgLens)
  const n = rows.length
  // 均值的 95% 置信区间半宽：t 分布用 2 近似（n<10 时偏乐观，但够用）
  const ci = n >= 2 ? Math.round((1.96 * s) / Math.sqrt(n) * 10) / 10 : NaN
  return { rows, n, meanAvg: n ? Math.round(mean(avgLens) * 10) / 10 : NaN, sd: Math.round(s * 10) / 10, ci }
}

/* ── 模型调用（与 app 的 llm.ts 同语义，但不依赖 Capacitor） ── */

async function chat(messages, opts) {
  const { apiKey: key, baseUrl: base, model, protocol } = loadConfig()
  if (!key) {
    throw new Error(
      `没有找到 API Key。两种填法：\n  1) 把 key 填进 ${CONFIG_FILE} 的 "apiKey" 字段\n  2) 或设环境变量 LLM_API_KEY`,
    )
  }

  const isAnthropic = protocol === 'anthropic'
  const thinkMode = loadConfig().thinking
  const url = isAnthropic
    ? /\/v\d+[a-z0-9.]*$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`
    : /\/chat\/completions$/i.test(base) ? base : /\/v\d+[a-z0-9.]*$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`

  const headers = { 'Content-Type': 'application/json' }
  let body

  if (isAnthropic) {
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    body = {
      model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      ...(system ? { system } : {}),
      messages: messages.filter((m) => m.role !== 'system'),
      stream: false,
    }
  } else {
    headers.Authorization = `Bearer ${key}`
    body = { model, messages, max_tokens: opts.maxTokens, temperature: opts.temperature, stream: false }
    // DeepSeek 系：disabled 直接关；low 走 reasoning_effort（budget_tokens 会被忽略）
    if (thinkMode === 'disabled') body.thinking = { type: 'disabled' }
    if (thinkMode === 'low') body.reasoning_effort = 'low'
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)

  const json = JSON.parse(text)
  const choice = (json.choices ?? [])[0]
  const content = isAnthropic
    ? (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    : choice?.message?.content ?? ''
  const reasoning = isAnthropic
    ? (json.content ?? []).filter((b) => b.type === 'thinking').map((b) => b.thinking ?? '').join('')
    : choice?.message?.reasoning_content ?? ''
  const finish = isAnthropic ? json.stop_reason : choice?.finish_reason

  return { content, reasoning, finish, usage: json.usage }
}

/**
 * 用量统计。口径与 app 的 `ArticleUsage` 一致：calls 是逻辑调用次数、requests 是实际请求数，
 * 两者不相等就说明中途撞过空正文/截断加码，那次是整轮重发的。
 *
 * 记这个是为了验证「提示词结构」而不是性能：静态要求前置后，换成另一批词表再跑，
 * 命中量应该基本不变；归零就说明变量又跑到前缀里去了。
 */
function emptyUsage() {
  return { prompt: 0, completion: 0, cached: 0, calls: 0, requests: 0 }
}

/** 单次 HTTP 请求的用量（三家字段名不同，这里统一认） */
function addAttempt(acc, u) {
  if (!u) return
  acc.prompt += u.prompt_tokens ?? u.input_tokens ?? 0
  acc.completion += u.completion_tokens ?? u.output_tokens ?? 0
  acc.cached +=
    u.prompt_tokens_details?.cached_tokens ??
    u.prompt_cache_hit_tokens ??
    u.cache_read_input_tokens ??
    0
  acc.requests += 1
}

function mergeUsage(into, from) {
  if (!from) return
  into.prompt += from.prompt
  into.completion += from.completion
  into.cached += from.cached
  into.requests += from.requests
  into.calls += 1
}

/**
 * 阶梯加预算调用。
 *
 * 推理模型（如 deepseek-flash）会先花几百到上千 token 思考，`max_tokens` 是**含思考**的总额度，
 * 于是正文还没开始写就被截断，返回 content 为空、finish_reason=length。
 * 做法和后端 app 的 `llm.ts` 一致：正文为空就翻倍预算再试，直到拿到内容。
 */
async function chatWithBudget(messages, temperature, budgets, label) {
  let last = null
  // 加码重试的那几次也花掉了 token，必须一起记，否则脚本比 app 少算一头
  const usage = emptyUsage()
  for (const b of budgets) {
    const r = await chat(messages, { temperature, maxTokens: b })
    addAttempt(usage, r.usage)
    if (r.content.trim()) return { ...r, usageTotal: usage }
    console.log(
      `    ${label} 空正文（finish=${r.finish}，思考 ${String(r.reasoning).length} 字），预算 ${b} → 加倍重试`,
    )
    last = r
  }
  throw new Error(
    `模型连续返回空正文（finish=${last?.finish}，思考 ${String(last?.reasoning).length} 字）——预算仍然不够或该模型不适合这个任务`,
  )
}

/** 宽松取 JSON，与 app 的 parseLoose 同策略 */
function parseLoose(raw) {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  return JSON.parse(s)
}

/* ── 输出 ───────────────────────────────── */

const pad = (s, n) => String(s).padEnd(n)
const col = (s, n) => String(s).padStart(n)

function printCorpus() {
  console.log(`\n提示词版本：${PROMPT_VERSION}`)
  console.log(`语料目录：${CORPUS_DIR}\n`)

  for (const lv of LEVELS) {
    const { rows, n, meanAvg, sd: sdv, ci } = corpusStats(lv)
    if (n === 0) {
      console.log(`${lv}：无语料（放 ${lv}.txt 到 scripts/corpus/）`)
      continue
    }

    console.log(`${pad(lv, 8)} 篇数 ${n}${n < MIN_SAMPLES ? `（少于 ${MIN_SAMPLES}，均值仅供参考）` : ''}`)
    console.log(`  ${pad('#', 3)}${col('words', 7)}${col('sents', 7)}${col('paras', 7)}${col('avg', 7)}${col('med', 7)}${col('max', 6)}${col('p90', 6)}${col('>30%', 7)}${col('>40%', 7)}`)
    rows.forEach((r, i) => {
      console.log(
        `  ${pad(i + 1, 3)}${col(r.words, 7)}${col(r.sentences, 7)}${col(r.paragraphs, 7)}${col(r.avg, 7)}${col(r.median, 7)}${col(r.max, 6)}${col(r.p90, 6)}${col(r.over30, 7)}${col(r.over40, 7)}`,
      )
    })
    console.log(
      `  均值 avg=${meanAvg}  sd=${sdv}  95%CI=±${Number.isNaN(ci) ? '—' : ci} 词/句` +
        (Number.isNaN(ci) ? '' : `   （要把 CI 压到 ±1.5 约需 ${Math.ceil((1.96 * sdv / 1.5) ** 2)} 篇）`),
    )
    console.log(`  规格里写的 avg 区间：[${LEVEL_SPEC[lv].avgSentence.join(', ')}]，篇幅 [${LEVEL_SPEC[lv].words.join(', ')}]\n`)
  }
}

/** 单篇生成：提纲 → 成文（和 app 的 generateArticle 同流程） */
async function generateOnce(lv, idx) {
  const t0 = Date.now()
  const genre = genreArg === 'expository' || genreArg === 'argument' ? genreArg : pickGenre(lv)
  const usage = emptyUsage()
  let outline = null
  try {
    const r = await chatWithBudget(buildOutlineMessages(words, lv, genre), 0.9, [1200, 3000], `[${lv} #${idx}] 提纲`)
    mergeUsage(usage, r.usageTotal)
    const o = parseLoose(r.content)
    outline = o && o.topic ? { topic: String(o.topic), paragraphs: o.paragraphs ?? [] } : null
  } catch (e) {
    console.log(`  [${lv} #${idx}] 提纲失败，退回单步：${String(e.message).slice(0, 90)}`)
  }

  const msgs = buildArticleMessages(words, lv, outline, genre)

  const r = await chatWithBudget(msgs, temp, [2600, 5200, 8192], `[${lv} #${idx}] 成文`)
  mergeUsage(usage, r.usageTotal)
  const parsed = parseLoose(r.content)

  const en = (parsed.sentences ?? []).map((s) => String(s.en ?? '')).filter(Boolean)
  const text = en.join(' ')
  const m = measure(text)
  const lens = splitSentences(text).map((s) => wordsOf(s).length)
  const covered = words.filter((w) => new RegExp(`\\b${w}`, 'i').test(text))

  return {
    level: lv,
    genre,
    ms: Date.now() - t0,
    title: parsed.title ?? '',
    metrics: m,
    veryLongCount: lens.filter((l) => l > 40).length,
    shortCount: lens.filter((l) => l <= 12).length,
    cover: covered.length,
    total: words.length,
    missing: words.filter((w) => !covered.includes(w)),
    sentences: en,
    usage,
  }
}

/** 一个级别跑 n 篇并打印逐篇 + 汇总（汇总对照真题均值与规格） */
async function runLevel(lv, n) {
  const spec = LEVEL_SPEC[lv]
  const stats = corpusStats(lv)
  const rows = []

  let failed = 0
  for (let i = 1; i <= n; i += 1) {
    let r
    try {
      r = await generateOnce(lv, i)
    } catch (e) {
      failed += 1
      console.log(`  [${lv} #${i}] 失败：${String(e.message).slice(0, 110)}`)
      continue
    }
    rows.push(r)
    const m = r.metrics
    console.log(
      `  [${lv} #${i}] ${GENRE_LABEL[r.genre]} · 词数 ${m.words}（${spec.words.join('~')}）` +
        ` · avg ${m.avg}（${spec.avgSentence.join('~')}，真题 ${stats.meanAvg}）` +
        ` · 最长 ${m.max}（≤${spec.maxSentence}）` +
        ` · >30词 ${m.over30}%` +
        ` · ≥40词句 ${r.veryLongCount}（≥${spec.veryLong}）` +
        ` · ≤12词句 ${r.shortCount}（≥${spec.shortSents}）` +
        ` · ${Math.round(r.ms / 1000)}s` +
        ` · 覆盖 ${r.cover}/${r.total}` +
        (r.cover < r.total ? ` 缺 ${r.missing.join(',')}` : ''),
    )
  }

  const avgOf = (k) => Math.round((rows.reduce((s, r) => s + r.metrics[k], 0) / rows.length) * 10) / 10
  const avgCount = (k) => Math.round((rows.reduce((s, r) => s + r[k], 0) / rows.length) * 10) / 10
  const verdict = (ok) => (ok ? '✓' : '✗')

  const sum = {
    words: avgOf('words'),
    avg: avgOf('avg'),
    max: avgOf('max'),
    over30: avgOf('over30'),
    veryLong: avgCount('veryLongCount'),
    short: avgCount('shortCount'),
    cover: avgCount('cover'),
  }

  console.log(`\n【${lv}】${n} 篇汇总`)
  console.log(
    `  词数 ${sum.words}（真题 ${Math.round(stats.rows.reduce((s, r) => s + r.words, 0) / Math.max(1, stats.n))}，规格 ${spec.words.join('~')}）` +
      `${verdict(sum.words >= spec.words[0] && sum.words <= spec.words[1])}`,
  )
  console.log(
    `  平均句长 ${sum.avg}（真题 ${stats.meanAvg}，规格 ${spec.avgSentence.join('~')}）` +
      `${verdict(sum.avg >= spec.avgSentence[0] && sum.avg <= spec.avgSentence[1])}`,
  )
  console.log(`  最长句 ${sum.max}（规格 ≤${spec.maxSentence}）${verdict(sum.max <= spec.maxSentence)}`)
  console.log(
    `  >30 词占比 ${sum.over30}%（真题 ${Math.round(stats.rows.reduce((s, r) => s + r.over30, 0) / Math.max(1, stats.n))}%）`,
  )
  console.log(`  ≥40 词句数 ${sum.veryLong}（规格 ≥${spec.veryLong}）${verdict(sum.veryLong >= spec.veryLong)}`)
  console.log(`  ≤12 词句数 ${sum.short}（规格 ≥${spec.shortSents}）${verdict(sum.short >= spec.shortSents)}`)
  console.log(`  目标词覆盖 ${sum.cover}/${words.length}`)
  if (failed > 0) console.log(`  ⚠ ${failed} 篇失败（计入分母外）`)

  // 命中率是这套脚本新增的对照项：提示词结构一变，第一处能看出来的就是它
  const usageSum = rows.reduce(
    (a, r) => ({
      prompt: a.prompt + (r.usage?.prompt ?? 0),
      completion: a.completion + (r.usage?.completion ?? 0),
      cached: a.cached + (r.usage?.cached ?? 0),
      calls: a.calls + (r.usage?.calls ?? 0),
      requests: a.requests + (r.usage?.requests ?? 0),
    }),
    emptyUsage(),
  )
  if (usageSum.prompt > 0) {
    const hit = Math.round((100 * usageSum.cached) / usageSum.prompt)
    console.log(
      `  用量 输入 ${usageSum.prompt}（命中 ${usageSum.cached}，${hit}%）` +
        ` · 输出 ${usageSum.completion}` +
        ` · 调用 ${usageSum.calls} / 请求 ${usageSum.requests}` +
        (usageSum.requests > usageSum.calls ? '（有重试）' : ''),
    )
  }
  console.log('')

  return { level: lv, runs: rows, failed, summary: sum, usage: usageSum, corpusMeanAvg: stats.meanAvg, spec, thinking: loadConfig().thinking }
}

async function generate() {
  if (words.length === 0) throw new Error('用 --words 或 --words-file 给出目标词')
  const cfg = loadConfig()
  console.log(`\n模型 ${cfg.model} · 提示词 ${PROMPT_VERSION} · 目标词 ${words.length} 个：${words.join(', ')}`)
  console.log(`每个级别 ${runs} 篇\n`)

  const targets = has('all') ? LEVELS : [level]
  const all = []
  for (const lv of targets) {
    console.log(`── ${lv} ──`)
    all.push(await runLevel(lv, runs))
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(OUT_DIR, `${stamp}-${targets.join('+')}.json`)
  writeFileSync(file, JSON.stringify({ promptVersion: PROMPT_VERSION, model: cfg.model, words, results: all }, null, 2))
  console.log(`结果已写入 ${file}`)

  // 跨级别一眼对比
  if (all.length > 1) {
    console.log('\n级别   avg(实测)  真题  最长  >30%  ≥40句  ≤12句  覆盖')
    for (const r of all) {
      console.log(
        `${r.level.padEnd(7)}${String(r.summary.avg).padStart(8)}${String(r.corpusMeanAvg).padStart(7)}` +
          `${String(r.summary.max).padStart(6)}${String(r.summary.over30 + '%').padStart(7)}` +
          `${String(r.summary.veryLong).padStart(7)}${String(r.summary.short).padStart(7)}` +
          `${String(r.summary.cover + '/' + words.length).padStart(8)}`,
      )
    }
  }
}

/* ── 入口 ───────────────────────────────── */

/** 列模型：用来确认 key 通不通、以及模型的准确 id（各家命名不一样，别靠猜） */
async function listModels() {
  const { apiKey, baseUrl, protocol } = loadConfig()
  if (!apiKey) {
    const msg = `没有找到 API Key。把 key 填进 ${CONFIG_FILE} 的 "apiKey" 字段（文件已备好）`
    console.error(msg)
    process.exit(1)
  }
  const url =
    protocol === 'anthropic'
      ? `${baseUrl}/v1/models`
      : /\/v\d+[a-z0-9.]*$/i.test(baseUrl)
        ? `${baseUrl}/models`
        : `${baseUrl}/v1/models`
  const headers = protocol === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${apiKey}` }

  const res = await fetch(url, { headers })
  const text = await res.text()
  if (!res.ok) {
    console.error(`HTTP ${res.status}：${text.slice(0, 300)}`)
    process.exit(1)
  }
  const json = JSON.parse(text)
  const ids = (json.data ?? []).map((m) => m.id).sort()
  console.log(`\n可用模型（${ids.length}）：`)
  for (const id of ids) console.log(`  ${id}`)
  console.log(`\n把要用的那个填进 ${CONFIG_FILE} 的 "model" 字段。`)
}

if (has('models')) {
  await listModels()
} else if (has('measure')) {
  printCorpus()
} else if (has('dry-run')) {
  console.log(`\n===== 提纲阶段提示词（${level}）=====\n`)
  for (const m of buildOutlineMessages(words.length ? words : ['example'], level, pickGenre(level))) {
    console.log(`[${m.role}]\n${m.content}\n`)
  }
  console.log(`\n===== 成文阶段提示词（${level}）=====\n`)
  for (const m of buildArticleMessages(words.length ? words : ['example'], level, null, pickGenre(level))) {
    console.log(`[${m.role}]\n${m.content}\n`)
  }
} else {
  try {
    await generate()
  } catch (e) {
    console.error(`\n失败：${e instanceof Error ? e.message : e}\n`)
    process.exit(1)
  }
}

// 语料目录不存在时给一句提示，而不是静默当空
if (!existsSync(CORPUS_DIR)) {
  console.log(
    `\n还没有语料目录。新建 ${CORPUS_DIR}，把真题按「一篇一段、篇与篇之间单独一行 ---」存成 <level>.txt`,
  )
}
