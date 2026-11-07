import { chatCompletion } from '@/api/llm'
import { activeModel, useLlm } from '@/store/llm'
import { lemmaCandidates } from '@/data/dict'
import type { TodaySnapshot } from '@/domain/collect'

export type ArticleMode = 'weak' | 'new' | 'all'
export type ArticleLevel = 'cet4' | 'cet6' | 'kaoyan' | 'ielts'

export const MODE_LABEL: Record<ArticleMode, string> = {
  weak: '忘记 + 模糊',
  new: '仅新学',
  all: '全部',
}

export const MODE_HINT: Record<ArticleMode, string> = {
  weak: '专攻没记住的词',
  new: '只练今天第一次见的词',
  all: '新学、模糊、忘记全用上',
}

export const LEVEL_LABEL: Record<ArticleLevel, string> = {
  cet4: '四级',
  cet6: '六级',
  kaoyan: '考研',
  ielts: '雅思',
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
  mode: ArticleMode
  level: ArticleLevel
  model: string
  createdAt: string
}

/** 第一步生成出来的提纲 */
export interface Outline {
  topic: string
  paragraphs: { idea: string; words: string[] }[]
}

/** 一篇文章最多塞多少个目标词，太多会变成词表 */
export const MAX_TARGET_WORDS = 25

/**
 * 按模式挑词。
 * 排序优先级：忘记 > 模糊 > 新学 —— 越容易忘的越值得在文章里再遇见一次。
 * exclude 里的词会被跳过，用来避免连续几篇反复覆盖同一批词。
 */
export function pickWords(
  days: TodaySnapshot[],
  mode: ArticleMode,
  limit = MAX_TARGET_WORDS,
  exclude?: Set<string>,
): string[] {
  const best = new Map<string, number>()

  for (const day of days) {
    for (const w of day.words) {
      const inNew = w.isNew
      const inWeak = w.firstResponse === 'VAGUE' || w.firstResponse === 'FORGET'

      const ok =
        mode === 'all' ? inNew || inWeak : mode === 'new' ? inNew : inWeak
      if (!ok) continue

      const key = w.spelling.trim()
      if (!key) continue
      if (exclude?.has(key.toLowerCase())) continue

      const score =
        w.firstResponse === 'FORGET' ? 0 : w.firstResponse === 'VAGUE' ? 1 : 2

      const prev = best.get(key)
      if (prev === undefined || score < prev) best.set(key, score)
    }
  }

  return [...best.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word)
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
    '你是一位资深的英语命题专家。你擅长围绕一组指定词汇，找到一个能真正承载它们的论点，' +
    '而不是把单词硬塞进句子里。'

  const user = [
    '一位学生今天需要复习下面这些单词：',
    words.join(', '),
    '',
    '请先设计一篇英语短文的写作提纲。要求：',
    `1. 难度定位：${LEVEL_HINT[level]}`,
    '2. 先想清楚这篇文章要论证或叙述什么，主题必须能自然容纳这些词',
    '3. 分 3~4 段，每段要有明确的推进：提出问题 → 展开 → 转折或深化 → 收束',
    '4. 把上面每个单词分配到最合适的那一段，一个词只分配一次',
    '',
    '只输出 JSON，不要任何解释：',
    '{"topic":"一句话说明文章主题与核心论点","paragraphs":[{"idea":"这一段要说什么","words":["该段用到的词"]}]}',
  ].join('\n')

  try {
    const raw = await chatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.9, maxTokens: 900 },
    )

    const obj = parseLoose(raw) as {
      topic?: unknown
      paragraphs?: Array<{ idea?: unknown; words?: unknown }>
    }

    const topic = typeof obj?.topic === 'string' ? obj.topic.trim() : ''
    const paragraphs = (Array.isArray(obj?.paragraphs) ? obj.paragraphs : [])
      .map((p) => ({
        idea: typeof p?.idea === 'string' ? p.idea.trim() : '',
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
    '你是一位资深的英语命题专家，擅长把指定词汇自然织入一篇连贯的短文。',
    '你从不把单词生硬地堆在一起，而是先想一个能承载这些概念的论点，再围绕它组织段落。',
  ].join('')

  const parts = [`请用下面这些单词写一篇英语短文。`, '', `【必须包含的单词】`, words.join(', '), '']

  if (outline) {
    parts.push(`【已确定的写作提纲】`, `主题与论点：${outline.topic}`)
    outline.paragraphs.forEach((p, i) => {
      const ws = p.words.length > 0 ? `（该段用：${p.words.join(', ')}）` : ''
      parts.push(`第 ${i + 1} 段：${p.idea}${ws}`)
    })
    parts.push('')
  }

  parts.push(
    `【要求】`,
    `1. 难度：${LEVEL_HINT[level]}`,
    `2. 篇幅：320~380 词`,
    outline ? `3. 严格按上面的提纲展开，段落顺序和论点不要改` : `3. 分 3~4 段，有完整的论证或叙事推进`,
    `4. 上面每一个单词都必须在正文中出现至少一次，原形或变形均可`,
    `5. 单词要顺着文意自然出现，不能为了塞词而牺牲句子通顺`,
    '',
    `【输出格式】`,
    `只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：`,
    `{"title":"英文标题","titleZh":"标题的中文翻译","sentences":[{"en":"英文句子","zh":"这句话的中文翻译"}]}`,
    '',
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
  words: string[]
  mode: ArticleMode
  level: ArticleLevel
  date: string
}

/**
 * 生成一篇文章：先列提纲，再按提纲成文。
 * 两步走比一步直出更不容易写成词表拼接 —— 模型先被迫想清楚要论证什么。
 * 提纲失败会自动退回单步生成；成文格式解析失败会重试一次。
 */
export async function generateArticle(opts: GenerateOptions): Promise<Article> {
  if (opts.words.length === 0) throw new Error('没有可用的单词')

  const { provider, model } = useLlm.getState()

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
        mode: opts.mode,
        level: opts.level,
        model: activeModel({ provider, model }),
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
