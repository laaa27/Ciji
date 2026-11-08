import { chatCompletion } from '@/api/llm'
import { useLlm } from '@/store/llm'
import { lemmaCandidates } from '@/data/dict'
import type { TodaySnapshot } from '@/domain/collect'

export type ArticleMode = 'weak' | 'new' | 'all'
/** 兼容旧数据：早期文章里可能存着 'ielts'，标签要能正常显示 */
export type ArticleLevel = 'cet4' | 'cet6' | 'kaoyan' | 'ielts'

/** 新生成时可选的难度（雅思用不上，从选项里去掉） */
export const LEVELS: ArticleLevel[] = ['cet4', 'cet6', 'kaoyan']

export const LEVEL_LABEL: Record<ArticleLevel, string> = {
  cet4: '四级',
  cet6: '六级',
  kaoyan: '考研',
  ielts: '雅思',
}

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
  model: string
  createdAt: string
}

/** 第一步生成出来的提纲 */
export interface Outline {
  topic: string
  paragraphs: { idea: string; link?: string; words: string[] }[]
}

/** 一篇文章最多塞多少个目标词，太多会变成词表 */
export const MAX_TARGET_WORDS = 25

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

    const kinds: WordKind[] = []
    if (w.groups.includes('forget')) kinds.push('forget')
    if (w.groups.includes('vague')) kinds.push('vague')
    if (w.isNew || w.groups.includes('new')) kinds.push('new')
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

const LEVEL_HINT: Record<ArticleLevel, string> = {
  cet4: '大学英语四级：词句平实，少用复杂从句',
  cet6: '大学英语六级：有一定句式变化，允许抽象表达',
  kaoyan: '考研英语一阅读理解：长难句、抽象名词、从句嵌套，但逻辑清晰',
  ielts: '雅思学术类阅读：学术语域，客观严谨，多用名词化表达',
}

/* ── 第一步：先列提纲 ─────────────────────── */

async function buildOutline(words: string[], level: ArticleLevel): Promise<Outline | null> {
  const system =
    '你是一位资深的英语命题专家。你最重要的原则是：一篇好文章不是把指定词汇挨个造句再排列起来，' +
    '而是先有一个真正想说的论点，词汇只是恰好出现在论证路径上。'

  const user = [
    '一位学生今天需要复习下面这些单词：',
    words.join(', '),
    '',
    '请先设计一篇英语短文的写作提纲。要求：',
    `1. 难度定位：${LEVEL_HINT[level]}`,
    '2. 先想一个具体、可展开的论点（不要选过于宽泛的「技术很重要」这类空话）',
    '3. 分 3~4 段，段落之间必须有明确的逻辑推进——递进、转折或因果，不允许四段并列',
    '4. 每段给出：核心论点句（topic sentence）+ 承接关系（这段如何承接上一段）+ 该段用哪些词',
    '5. 把每个单词分配到最合适的一段，一个词只分配一次',
    '',
    '只输出 JSON，不要任何解释：',
    '{"topic":"一句话说明文章主题与核心论点","paragraphs":[{"idea":"这一段的核心论点句","link":"如何承接上一段（第一段写「开篇」）","words":["该段用到的词"]}]}',
  ].join('\n')

  try {
    const raw = await chatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.9, maxTokens: 1000 },
    )

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

/* ── 第二步：按提纲成文 ───────────────────── */

function buildMessages(words: string[], level: ArticleLevel, outline: Outline | null) {
  const system = [
    '你是一位资深的英语命题专家。你最重要的原则：好文章不是把指定词汇挨个造句再排列起来，',
    '而是先有一个真正想说的论点，词汇只是恰好出现在论证路径上。',
  ].join('')

  const parts = [`请用下面这些单词写一篇英语短文。`, '', `【必须包含的单词】`, words.join(', '), '']

  if (outline) {
    parts.push(`【已确定的写作提纲】`, `主题与论点：${outline.topic}`)
    outline.paragraphs.forEach((p, i) => {
      const ws = p.words.length > 0 ? `（该段用：${p.words.join(', ')}）` : ''
      const link = p.link ? `〔承接：${p.link}〕` : ''
      parts.push(`第 ${i + 1} 段：${p.idea}${link}${ws}`)
    })
    parts.push('')
  }

  parts.push(
    `【要求】`,
    `1. 难度：${LEVEL_HINT[level]}`,
    `2. 篇幅：必须 320~380 词。少于 280 词视为不合格，写完先数一遍`,
    outline
      ? `3. 严格按提纲展开，段落顺序和论点不要改；提纲里的「承接」必须落实为真实的过渡句`
      : `3. 分 3~4 段，段落之间用递进/转折/因果连接，不允许并列罗列`,
    `4. 上面每一个单词都必须在正文中出现至少一次，原形或变形均可`,
    ``,
    `【写作红线】`,
    `- 禁止逐词造句再拼接：每个段落必须围绕该段的中心论点展开，段内的句子要互相支撑`,
    `- 代词必须有明确的指代对象；However / Therefore 这类衔接词必须存在真实的逻辑关系，不是装饰`,
    `- 自查标准：把目标单词全部拿掉，剩下的文字仍然是一篇逻辑通顺的文章——达不到就重写`,
    ``,
    `【输出格式】`,
    `只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：`,
    `{"title":"英文标题","titleZh":"标题的中文翻译","sentences":[{"en":"英文句子","zh":"这句话的中文翻译"}]}`,
    ``,
    `注意：sentences 数组要把正文按句子切开，一句一项，英文和中文一一对应。`,
  )

  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: parts.join('\n') },
  ]
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

  const normalized = new Set<string>()
  for (const token of tokens) {
    for (const cand of lemmaCandidates(token)) normalized.add(cand)
  }

  return article.targetWords.filter((w) => !normalized.has(w.toLowerCase()))
}

export interface GenerateOptions {
  /** 用户在选词界面里确认过的词（顺序即优先级） */
  words: string[]
  /** 勾选过的类型，只用于记录 */
  kinds: WordKind[]
  level: ArticleLevel
  date: string
}

/** kinds → 旧的 mode 字段，保证老代码/老数据一条线 */
function modeOf(kinds: WordKind[]): ArticleMode {
  const hasNew = kinds.includes('new')
  const hasWeak = kinds.includes('forget') || kinds.includes('vague')
  if (hasNew && !hasWeak) return 'new'
  if (!hasNew && hasWeak) return 'weak'
  return 'all'
}

/**
 * 生成一篇文章：先列提纲，再按提纲成文。
 * 两步走比一步直出更不容易写成词表拼接 —— 模型先被迫想清楚要论证什么。
 * 提纲失败会自动退回单步生成；成文格式解析失败会重试一次。
 */
export async function generateArticle(opts: GenerateOptions): Promise<Article> {
  if (opts.words.length === 0) throw new Error('没有可用的单词')

  // 记录用的是哪份配置、哪个模型：以后换了模型，旧文章的来源仍然查得到
  const profile = useLlm.getState().active()

  // 第一步：提纲
  const outline = await buildOutline(opts.words, opts.level)

  const messages = buildMessages(opts.words, opts.level, outline)

  let lastError: unknown = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await chatCompletion(messages, {
        temperature: 0.85,
        maxTokens: 2600,
      })

      const { title, titleZh, sentences } = validate(parseLoose(raw))

      return {
        date: opts.date,
        title,
        titleZh,
        sentences,
        targetWords: opts.words,
        kinds: opts.kinds,
        mode: modeOf(opts.kinds),
        level: opts.level,
        model: profile ? `${profile.name} / ${profile.model}` : 'unknown',
        createdAt: new Date().toISOString(),
      }
    } catch (e) {
      lastError = e
    }
  }

  throw lastError instanceof Error ? lastError : new Error('生成失败')
}

export function wordCount(article: Pick<Article, 'sentences'>): number {
  return article.sentences.reduce(
    (sum, s) => sum + (s.en.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0),
    0,
  )
}
