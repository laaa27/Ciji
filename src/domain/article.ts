import { chatCompletion } from '@/api/llm'
import { useLlm } from '@/store/llm'
import { lemmaCandidates } from '@/data/dict'
import { sleep } from '@/lib/async'
import { countWords, countWordsIn } from '@/lib/text'
import type { TodaySnapshot } from '@/domain/collect'
import {
  buildArticleMessages,
  buildOutlineMessages,
  LEVEL_SPEC,
  pickGenre,
  type ArticleLevel,
  type Genre,
  type Outline,
} from '@/domain/prompts'

export type ArticleMode = 'weak' | 'new' | 'all'

/**
 * 难度类型、标签、提示词全部住在 `domain/prompts.ts` —— 那边零依赖，
 * `scripts/gen-article.mjs` 能在 node 里用同一份文本做对比实验。
 */
export type { ArticleLevel, Genre, Outline } from '@/domain/prompts'
export { LEVEL_LABEL, GENRE_LABEL, pickGenre } from '@/domain/prompts'

/** 新生成时可选的难度（雅思用不上，从选项里去掉） */
export const LEVELS: ArticleLevel[] = ['cet4', 'cet6', 'kaoyan']

/** 单词类型：与今天页的三组一一对应 */
export type WordKind = 'forget' | 'vague' | 'new'

export const KIND_LABEL: Record<WordKind, string> = {
  forget: '忘记',
  vague: '模糊',
  new: '新学',
}

export interface WordCandidate {
  spelling: string
  /** 一个词可能同时属于多个类型（新学又答错的词） */
  kinds: WordKind[]
  /** 已被这一天的某篇文章用过 */
  used: boolean
}

export interface ArticleSentence {
  en: string
  zh: string
}

export interface Article {
  /** 存库后才有，形如 2026-11-07#2 */
  id?: string
  date: string
  title: string
  /** 标题的中文翻译，早期版本的文章没有这个字段 */
  titleZh?: string
  sentences: ArticleSentence[]
  /** 本篇要求覆盖的词 */
  targetWords: string[]
  /** 生成时勾选了几类词（老文章没有这个字段，回退到 mode） */
  kinds?: WordKind[]
  mode: ArticleMode
  level: ArticleLevel
  /** 文体（老文章没有这个字段，界面按没有处理） */
  genre?: Genre
  model: string
  createdAt: string
  /**
   * 生成后校验没通过时记下来（篇幅偏短 / 缺词 / 超长句）。
   * 有值不代表文章不能用，只代表它没完全达到该档位的规格，界面据此轻提示。
   */
  shortfall?: string
  /**
   * 用户在生成页点了「清除当天已用记录」：本篇的 targetWords 不再计入当天已用，
   * 那些词恢复默认可选。文章本身保留，可继续阅读。老文章没有此字段 = 计入。
   */
  skipCoverage?: boolean
}

/** 选词上限与档位定义在 prompts.ts（零依赖），这里转出去保持既有 import 路径不变 */
export { MAX_TARGET_WORDS, WORD_LIMITS } from '@/domain/prompts'

/**
 * 取某一天的候选词。
 *
 * 以前是从最近 7 天合起来挑，会把历史词混进来 —— 这里只认传进来的那一天。
 * 排序：忘记 > 模糊 > 新学，同优先级按字母 —— 越容易忘的越值得在文章里再遇见一次。
 */
export function wordCandidates(
  day: TodaySnapshot | null,
  usedToday: Set<string>,
): WordCandidate[] {
  if (!day) return []

  const map = new Map<string, WordCandidate>()

  for (const w of day.words) {
    const spelling = w.spelling.trim()
    if (!spelling) continue

    // 三类互斥（与 collect.classify 同规则）：新学词只算「新学」，
    // 忘记 / 模糊只收复习词。旧快照里可能残留多归属分组，这里统一掰正。
    const kinds: WordKind[] = []
    if (w.isNew) {
      kinds.push('new')
    } else {
      if (w.groups.includes('forget')) kinds.push('forget')
      if (w.groups.includes('vague')) kinds.push('vague')
      if (w.groups.includes('new')) kinds.push('new')
    }
    if (kinds.length === 0) continue

    const key = spelling.toLowerCase()
    const prev = map.get(key)
    if (prev) {
      // 同一天里同一个词出现多次：合并类型
      for (const k of kinds) if (!prev.kinds.includes(k)) prev.kinds.push(k)
      continue
    }
    map.set(key, { spelling, kinds, used: usedToday.has(key) })
  }

  const rank = (c: WordCandidate) =>
    c.kinds.includes('forget') ? 0 : c.kinds.includes('vague') ? 1 : 2

  return [...map.values()].sort(
    (a, b) => rank(a) - rank(b) || a.spelling.localeCompare(b.spelling),
  )
}

/**
 * 按勾选的类型算出「默认该选哪些词」。
 * 当天已用过的词默认排除 —— 想再用一次得自己手动勾。
 */
export function defaultSelection(cands: WordCandidate[], kinds: WordKind[]): string[] {
  return cands
    .filter((c) => !c.used && c.kinds.some((k) => kinds.includes(k)))
    .map((c) => c.spelling.toLowerCase())
}

/** 勾选过多时按「忘记 > 模糊 > 新学」保留前 limit 个 */
export function trimSelection(
  cands: WordCandidate[],
  selected: Set<string>,
  limit: number,
): string[] {
  return cands
    .filter((c) => selected.has(c.spelling.toLowerCase()))
    .slice(0, limit)
    .map((c) => c.spelling)
}

/* ── 第一步：先列提纲 ─────────────────────── */

async function buildOutline(
  words: string[],
  level: ArticleLevel,
  genre: Genre,
): Promise<Outline | null> {
  try {
    const raw = await chatCompletion(buildOutlineMessages(words, level, genre), {
      temperature: 0.9,
      maxTokens: 3000,
      ...thinkingOpts(),
    })

    const obj = parseLoose(raw) as {
      topic?: unknown
      paragraphs?: Array<{ idea?: unknown; link?: unknown; words?: unknown }>
    }

    const topic = typeof obj?.topic === 'string' ? obj.topic.trim() : ''
    const paragraphs = (Array.isArray(obj?.paragraphs) ? obj.paragraphs : [])
      .map((p) => ({
        idea: typeof p?.idea === 'string' ? p.idea.trim() : '',
        link: typeof p?.link === 'string' ? p.link.trim() : '',
        words: Array.isArray(p?.words)
          ? p.words.filter((w): w is string => typeof w === 'string')
          : [],
      }))
      .filter((p) => p.idea)

    if (!topic || paragraphs.length === 0) return null
    return { topic, paragraphs }
  } catch {
    // 提纲失败不影响主流程，退回单步生成
    return null
  }
}

/** 模型有时会包 ```json，或者前面带一句客套话，这里宽松取 JSON */
function parseLoose(raw: string): unknown {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  return JSON.parse(s)
}

function validate(parsed: unknown): {
  title: string
  titleZh?: string
  sentences: ArticleSentence[]
} {
  const obj = parsed as {
    title?: unknown
    titleZh?: unknown
    sentences?: Array<{ en?: unknown; zh?: unknown }>
  }

  const title = typeof obj?.title === 'string' ? obj.title.trim() : ''
  const titleZh = typeof obj?.titleZh === 'string' ? obj.titleZh.trim() : ''
  const list = Array.isArray(obj?.sentences) ? obj.sentences : []

  const sentences: ArticleSentence[] = []
  for (const s of list) {
    const en = typeof s?.en === 'string' ? s.en.trim() : ''
    const zh = typeof s?.zh === 'string' ? s.zh.trim() : ''
    if (en) sentences.push({ en, zh })
  }

  if (!title || sentences.length === 0) {
    throw new Error('模型返回的内容不完整')
  }

  return { title, titleZh: titleZh || undefined, sentences }
}

/** 校验哪些目标词没出现在正文里 */
export function missingWords(article: Pick<Article, 'sentences' | 'targetWords'>): string[] {
  const text = article.sentences.map((s) => s.en).join(' ').toLowerCase()
  const tokens = text.match(/[a-z][a-z'-]*/g) ?? []

  // 每个 token 的全部还原候选（rests → [rests, rest]），既做单词条集合，也保住位置
  const lemmas: string[][] = tokens.map((token) => lemmaCandidates(token))
  const normalized = new Set(lemmas.flat())

  return article.targetWords.filter((w) => !isCovered(w, lemmas, normalized))
}

/**
 * 目标词是否被正文覆盖。
 *
 * 单词：词元集合里找得到就算用上（rests / rest 都算覆盖了 rest）。
 * 短语（rest on / be meant to）：在词元序列里找一个**连续窗口**逐词覆盖——
 * 原先把它当整体字符串查集合，永远查不到，「明明用上了却说未用到」；
 * 逐词覆盖后，rests on 覆盖 rest on，was meant to（was→be）覆盖 be meant to。
 */
function isCovered(word: string, lemmas: string[][], normalized: Set<string>): boolean {
  const words = word.toLowerCase().trim().split(/\s+/)
  if (words.length === 1) return normalized.has(words[0])

  if (words.length > lemmas.length) return false
  outer: for (let i = 0; i + words.length <= lemmas.length; i += 1) {
    for (let j = 0; j < words.length; j += 1) {
      if (!lemmas[i + j].includes(words[j])) continue outer
    }
    return true
  }
  return false
}

export interface GenerateOptions {
  /** 用户在选词界面里确认过的词（顺序即优先级） */
  words: string[]
  /** 勾选过的类型，只用于记录 */
  kinds: WordKind[]
  level: ArticleLevel
  date: string
  /** 指定文体；不传就按该档的配额抽签（界面上没有文体开关） */
  genre?: Genre
}

/** kinds → 旧的 mode 字段，保证老代码/老数据一条线 */
function modeOf(kinds: WordKind[]): ArticleMode {
  const hasNew = kinds.includes('new')
  const hasWeak = kinds.includes('forget') || kinds.includes('vague')
  if (hasNew && !hasWeak) return 'new'
  if (!hasNew && hasWeak) return 'weak'
  return 'all'
}

/** 名词化后缀：与 scripts/analyze-difficulty.py 的口径一致，方便两边数字对得上 */
const NOMINAL_SUFFIX = /(tion|sion|ment|ance|ence|ity|ness|ism|ship)$/i
/** 真题名词化 2.1~3.5 / 百词、被动 5.8%~19.8%；超过说明写成了学术摘要而不是考试阅读 */
const MAX_NOMINAL_PER_100 = 6
const MAX_PASSIVE_RATIO = 22
/** 「, which / , who」非限制性定语从句最多几句：真题四级一篇约 0.4 句、考研约 1.7 句 */
const MAX_NONRESTRICTIVE = 3
/** 主张表述：议论文靠它立论，说明文里出现就是跑偏 */
const CLAIM_WORDS = /\b(should|must|ought to|need to|had better)\b/gi
/** 说明文允许的「应该」处数（留给引述他人观点的余地） */
const MAX_EXPOSITORY_CLAIMS = 2

/**
 * 生成后审计：这一篇够不够得上它的档位。
 *
 * 实测（deepseek-flash）合格率只有四成左右：篇幅经常只有目标的六成，
 * 偶尔还会塌成一百多词的残篇、目标词只用到三分之一。光靠提示词压不住，
 * 所以在代码侧再拦一道，不合格就重新生成。
 *
 * 2026-11 补的两条，对应「四级偏简单 / 六级考研偏难」这两个真实偏差
 * （实测数据见 `词迹-生成难度偏差分析.md`）：
 * - 平均句长要落在区间内：原来只查最长句上限，四级写成 13.8 词/句（真题 19.4）也不报
 * - 名词化与被动占比：写成「允许/适度」时模型会当目标追，实测翻 2~3 倍
 */
function auditArticle(
  a: Pick<Article, 'sentences' | 'targetWords'>,
  level: ArticleLevel,
  genre: Genre,
): string[] {
  const spec = LEVEL_SPEC[level]
  const problems: string[] = []

  const words = wordCount(a)
  const floor = Math.round(spec.words[0] * 0.9)
  if (words < floor) {
    problems.push(`篇幅偏短（${words} 词，目标 ${spec.words[0]}~${spec.words[1]}）`)
  }

  const missing = missingWords(a)
  if (missing.length > 0) {
    const head = missing.slice(0, 5).join('、')
    problems.push(`缺 ${missing.length} 个目标词：${head}${missing.length > 5 ? '…' : ''}`)
  }

  const lens = a.sentences.map((s) => countWords(s.en))
  const longest = lens.reduce((max, l) => Math.max(max, l), 0)
  if (longest > spec.maxSentence) {
    problems.push(`有 ${longest} 词的长句（上限 ${spec.maxSentence}）`)
  }

  // 末句没有收尾标点 = 输出被截断（实测思考吃光额度时就这样：正文写一半就停），
  // 这种残篇不能当成品交付，必须重生成
  const lastEn = a.sentences[a.sentences.length - 1]?.en.trim() ?? ''
  if (lastEn && !/[.!?"'”’）)]$/.test(lastEn)) {
    problems.push('结尾不完整（最后一句没有收尾标点，多半是输出被截断）')
  }

  // 平均句长允许浮动：卡死在区间边界会把合格文章打回去重生成。
  // 说明文要解释机制和成因，实测句长天然高一截（21.5~25.2 vs 规格 18~21），所以多放 1 词。
  const avg = words / Math.max(1, lens.length)
  const [aMin, aMax] = spec.avgSentence
  const avgSlack = genre === 'expository' ? 3 : 2
  if (avg < aMin - 2 || avg > aMax + avgSlack) {
    problems.push(`平均句长 ${avg.toFixed(1)} 词（目标 ${aMin}~${aMax}）`)
  }

  const tokens = a.sentences.map((s) => s.en).join(' ').match(/[A-Za-z][A-Za-z'-]*/g) ?? []
  const nominal = tokens.filter((w) => w.length > 5 && NOMINAL_SUFFIX.test(w)).length
  const nominalPct = (100 * nominal) / Math.max(1, tokens.length)
  if (nominalPct > MAX_NOMINAL_PER_100) {
    problems.push(`名词化过密（每百词 ${nominalPct.toFixed(1)} 个，上限 ${MAX_NOMINAL_PER_100}）`)
  }

  const passive = a.sentences.filter((s) =>
    /\b(is|are|was|were|be|been|being)\s+([a-z]+ed|[a-z]+en)\b/i.test(s.en),
  ).length
  const passivePct = (100 * passive) / Math.max(1, lens.length)
  if (passivePct > MAX_PASSIVE_RATIO) {
    problems.push(`被动句过多（${passivePct.toFixed(0)}% 的句子，上限 ${MAX_PASSIVE_RATIO}%）`)
  }

  // 用同一个模板反复凑长句：实测一篇四级稿 15 句里有 6 句是「, which …」，
  // 真题四级 2.4% 的句子有这种结构（一篇约 0.4 句）。超过 3 处就是模板化，重写。
  const nonRestrictive = a.sentences.filter((s) => /,\s+(which|who)\b/i.test(s.en)).length
  if (nonRestrictive > MAX_NONRESTRICTIVE) {
    problems.push(`「, which/who」用得太密（${nonRestrictive} 句，上限 ${MAX_NONRESTRICTIVE}）`)
  }

  // 文体一致性。提示词里已经交代了文体，但模型很容易滑回"给建议"的老路：
  // 说明文写成提案（should 满天飞）、议论文写成纯描述（一个主张都没有），都要打回。
  const claims = (a.sentences.map((s) => s.en).join(' ').match(CLAIM_WORDS) ?? []).length
  if (genre === 'expository' && claims > MAX_EXPOSITORY_CLAIMS) {
    problems.push(`说明文里出现了 ${claims} 处「应该/必须」，写成了建议文（上限 ${MAX_EXPOSITORY_CLAIMS}）`)
  }
  if (genre === 'argument' && claims === 0) {
    problems.push('议论文里没有任何主张表述（should / must），写成了纯描述')
  }

  return problems
}

/** 最多生成几次：1 次初稿 + 1 次重生成 */
const MAX_GENERATE_ATTEMPTS = 2

/**
 * 生成过程中对外汇报的「大致进度」。
 * 只用来给用户一个"模型在忙什么"的交代，不追求精确——
 * 每阶段真实耗时不稳（思考量随提示词波动），所以界面拿它做步骤指示而不是进度条。
 */
export type GenStage = 'outline' | 'draft' | 'revise' | 'save'

export interface GenProgress {
  stage: GenStage
  /** 第几次成文（1 = 初稿，2 = 审计未过后的重写） */
  attempt: number
}

export type GenProgressHandler = (p: GenProgress) => void

/**
 * 按设置决定思考参数（设置 → 大模型 → 「文章生成 · 思考模式」）。
 * 开：reasoning low 档 —— deepseek-flash 实测合格率 5/5，代价是 50~90 秒/篇；
 * 关：显式 thinking.disabled —— 秒级返回、费用更低，但推理模型实测约半数会塌成短文（审计层会兜住并重生成）。
 * 普通模型不认这些字段时，运行时会按 400 报错自动去掉，不影响使用。
 */
function thinkingOpts(): { reasoningEffort: 'low' } | { thinkingDisabled: true } {
  return useLlm.getState().thinkGen
    ? { reasoningEffort: 'low' }
    : { thinkingDisabled: true }
}
/** 成文预算：推理模型会把额度分给思考。16000 是实测能写完 400 词正文并留出思考余量的起点；
 *  还不够时 llm.ts 会逐级加到 32000。 */
const ARTICLE_MAX_TOKENS = 16000

/**
 * 生成一篇文章：先列提纲，再按提纲成文。
 * 两步走比一步直出更不容易写成词表拼接 —— 模型先被迫想清楚要论证什么。
 * 提纲失败会自动退回单步生成；成文格式解析失败会重试一次。
 *
 * onProgress 在每次换阶段时回调一次（提纲 → 成文 → 必要时重写），
 * 让界面能说清"现在在干嘛"，而不是只有一个转圈。
 */
export async function generateArticle(
  opts: GenerateOptions,
  onProgress?: GenProgressHandler,
): Promise<Article> {
  if (opts.words.length === 0) throw new Error('没有可用的单词')

  // 记录用的是哪份配置、哪个模型：以后换了模型，旧文章的来源仍然查得到
  const profile = useLlm.getState().active()

  // 文体按档位配额抽（四级以说明文为主）：同一个词表连生成几篇，不会篇篇都是"应该怎么做"
  const genre = opts.genre ?? pickGenre(opts.level)

  // 第一步：提纲
  onProgress?.({ stage: 'outline', attempt: 1 })
  const outline = await buildOutline(opts.words, opts.level, genre)

  const messages = buildArticleMessages(opts.words, opts.level, outline, genre)

  let lastError: unknown = null
  /** 有硬伤但勉强能用的一篇：重生成也不合格时交它，别让用户白等 */
  let best: { article: Article; problems: string[] } | null = null

  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(400)

    onProgress?.({ stage: attempt === 0 ? 'draft' : 'revise', attempt: attempt + 1 })

    try {
      const raw = await chatCompletion(messages, {
        temperature: 0.85,
        maxTokens: ARTICLE_MAX_TOKENS,
        ...thinkingOpts(),
      })

      const { title, titleZh, sentences } = validate(parseLoose(raw))

      const article: Article = {
        date: opts.date,
        title,
        titleZh,
        sentences,
        targetWords: opts.words,
        kinds: opts.kinds,
        mode: modeOf(opts.kinds),
        level: opts.level,
        genre,
        model: profile ? `${profile.name} / ${profile.model}` : 'unknown',
        createdAt: new Date().toISOString(),
      }

      const problems = auditArticle(article, opts.level, genre)
      if (problems.length === 0) return article

      if (!best || problems.length < best.problems.length) best = { article, problems }
    } catch (e) {
      lastError = e
    }
  }

  // 两次都有硬伤：交出问题最少的那篇，并如实标注，而不是假装成功
  if (best) return { ...best.article, shortfall: best.problems.join('；') }

  throw lastError instanceof Error ? lastError : new Error('生成失败')
}

export function wordCount(article: Pick<Article, 'sentences'>): number {
  return countWordsIn(article.sentences)
}
