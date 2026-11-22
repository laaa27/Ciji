import { chatCompletion, type CallUsage } from '@/api/llm'
import { useLlm } from '@/store/llm'
import { distance, locateDefects, measure, type LocatedDefect } from '@/domain/generate/metrics'
import { auditArticle } from '@/domain/generate/audit'
import {
  DRAFT_TEMPERATURES,
  rankCandidates,
  runParallel,
  type Candidate,
} from '@/domain/generate/select'
import {
  buildArticleMessages,
  buildOutlineMessages,
  pickGenre,
  type ArticleLevel,
  type Genre,
  type Outline,
} from '@/domain/prompts'

import type { Article, ArticleMode, ArticleSentence, ArticleUsage, WordKind } from './model'

/**
 * 生成编排：提纲 → 并行成文 → 规则择优 →（仍有硬伤）回喂问题重写一次。
 *
 * 这是 `domain/article.ts` 里唯一碰模型的部分，也是**唯一一条已知的层间偏离**
 * （domain → store/llm，见开发手册 2.2）。单独一个文件之后，这条偏离被关在
 * 70 行的边界内：选词、文本导出、类型定义都能在 node 里直接跑。
 */

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

/**
 * 生成过程中对外汇报的「大致进度」。
 * 只用来给用户一个"模型在忙什么"的交代，不追求精确——
 * 每阶段真实耗时不稳（思考量随提示词波动），所以界面拿它做步骤指示而不是进度条。
 */
export type GenStage = 'outline' | 'draft' | 'revise' | 'save'

export interface GenProgress {
  stage: GenStage
  /** 第几次成文（1 = 并行初稿，2 = 仍有硬伤时的定向重写） */
  attempt: number
  /** 并行的完成进度：已完成几篇 / 一共几篇。只有成文阶段会填 */
  done?: number
  total?: number
}

export type GenProgressHandler = (p: GenProgress) => void

/**
 * 思考模式：一律显式关闭（2026-11-14 从设置里移除）。
 *
 * 必须显式发 `thinking.disabled` —— 不传参数不等于关闭，推理模型默认就开着思考。
 * 之所以可以一律关：关思考的代价是塌篇（~25%），而塌掉的候选在并行 4 路择优里会被直接淘汰，
 * 不再值得为它多等 40~50 秒。服务端不认这个字段时，llm.ts 会按 400 自动去掉。
 */
const THINKING_OFF = { thinkingDisabled: true } as const
/** 成文预算：推理模型会把额度分给思考。16000 是实测能写完 400 词正文并留出思考余量的起点；
 *  还不够时 llm.ts 会逐级加到 32000。 */
const ARTICLE_MAX_TOKENS = 16000

/* ── 第一步：先列提纲 ─────────────────────── */

async function buildOutline(
  words: string[],
  level: ArticleLevel,
  genre: Genre,
): Promise<{ outline: Outline | null; usage: CallUsage | null }> {
  try {
    const { text, usage } = await chatCompletion(buildOutlineMessages(words, level, genre), {
      temperature: 0.9,
      maxTokens: 3000,
      ...THINKING_OFF,
    })

    const obj = parseLoose(text) as {
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

    // token 已经花掉了，哪怕提纲解析不出来也要把这笔账交回去
    if (!topic || paragraphs.length === 0) return { outline: null, usage }
    return { outline: { topic, paragraphs }, usage }
  } catch {
    // 提纲失败不影响主流程，退回单步生成
    return { outline: null, usage: null }
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

/**
 * 重写指令：把审计发现的问题原样回喂给模型，能指到句子的就指到句子。
 *
 * 为什么必须回喂：重试如果原样重发同一份 messages，第二次只是重新抽签，不是「按批评修改」。
 * 旧版就是这么做的，复算时 7/8 的重写稿仍然不合格（问题清单在代码里，模型看不见）。
 *
 * 为什么要定位到句：只报「对偶 4 处、上限 2」这类统计量时，模型得自己找出是哪几句，
 * 而它并不擅长这件事（Self-Refine 的消融：具体反馈 43.2 vs 泛泛反馈 31.2）。
 */
function revisionRequest(problems: string[], located: LocatedDefect[] = []): string {
  const lines = [
    '上一稿没有通过审核，问题如下：',
    ...problems.map((p, i) => `${i + 1}. ${p}`),
  ]
  if (located.length > 0) {
    lines.push('', '其中几处能直接指到句子，逐句改：')
    for (const d of located) lines.push(`- 「${d.text}」→ ${d.reason}`)
  }
  lines.push(
    '',
    '请逐条修正后重写全文，未被指出的部分保持上一稿的写法：',
    '- 只输出一个 JSON 对象（title / titleZh / sentences），不要解释改了什么',
    '- 目标词仍然每个都要出现至少一次；改短了句子就要在别处补回信息，总词数和句数不能掉',
  )
  return lines.join('\n')
}

/**
 * 生成一篇文章：先列提纲，再**并行**按提纲成文 K 篇，本地按规则择优。
 *
 * 为什么改成并行：旧流程是「成文 → 审计 → 不合格就串行重写」，重试必然加时间，
 * 而首轮合格率只有四成，等于六成文章要跑两轮。改成一次多跑几路、本地挑最好的之后，
 * 墙钟从「两轮」降到「一轮」，质量反而更好（多篇里挑胜过一篇赌运气）。
 *
 * 选择用**确定性规则**（审计硬伤 + 到真题形状的距离），不让模型当评委——
 * 模型评判自己人时误差会被 argmax 放大，散文类实测 N 超过个位数就开始变差。
 *
 * 提纲失败退回单步生成；四路全挂才报错；最优仍有硬伤时回喂问题做一次定向重写。
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

  /** 本篇累计用量；服务端不报 usage 的网关会让 calls 保持 0，最后就不写这个字段 */
  const usage: ArticleUsage = { prompt: 0, completion: 0, cached: 0, calls: 0, requests: 0 }

  /**
   * 把一次调用的用量并进来。用量跟着返回值走，不再从模块级单例里取——
   * 并行之后几路调用同时在飞，单例会互相覆盖（见 api/llm.ts 的 ChatResult 注释）。
   *
   * 收在「调用之后、判断成败之前」：提纲 JSON 解析失败时 token 照样花掉了，
   * 这时候不该因为没有提纲就把这次开销从账上抹掉。
   */
  const addUsage = (u: CallUsage | null) => {
    if (!u) return
    usage.prompt += u.prompt
    usage.completion += u.completion
    usage.cached += u.cached
    usage.calls += 1
    usage.requests += u.requests
  }

  /** 装配成品：用量在最后统一挂上，过程中不用反复同步 */
  const finish = (a: Article, problems: string[] = []): Article => ({
    ...a,
    usage: usage.calls > 0 ? { ...usage } : undefined,
    ...(problems.length > 0 ? { shortfall: problems.join('；') } : {}),
  })

  const assemble = (raw: { title: string; titleZh?: string; sentences: ArticleSentence[] }): Article => ({
    date: opts.date,
    title: raw.title,
    titleZh: raw.titleZh,
    sentences: raw.sentences,
    targetWords: opts.words,
    kinds: opts.kinds,
    mode: modeOf(opts.kinds),
    level: opts.level,
    genre,
    model: profile ? `${profile.name} / ${profile.model}` : 'unknown',
    createdAt: new Date().toISOString(),
  })

  /** 一篇候选：硬伤（能不能交）+ 距离（够不够像真题） */
  const evaluate = (a: Article): Candidate<Article> => ({
    item: a,
    problems: auditArticle(a, opts.level, genre),
    distance: distance(measure(a.sentences, opts.level), opts.level),
  })

  // 第一步：提纲
  onProgress?.({ stage: 'outline', attempt: 1 })
  const outlineCall = await buildOutline(opts.words, opts.level, genre)
  addUsage(outlineCall.usage)
  const baseMessages = buildArticleMessages(opts.words, opts.level, outlineCall.outline, genre)

  // 第二步：并行成文。温度阶梯让候选真的不一样——同温度跑四遍等于白花三份钱
  let done = 0
  onProgress?.({ stage: 'draft', attempt: 1, done: 0, total: DRAFT_TEMPERATURES.length })
  const drafted = await runParallel(
    DRAFT_TEMPERATURES.map((temperature) => async () => {
      const { text, usage: callUsage } = await chatCompletion(baseMessages, {
        temperature,
        maxTokens: ARTICLE_MAX_TOKENS,
        ...THINKING_OFF,
      })
      addUsage(callUsage)
      const article = assemble(validate(parseLoose(text)))
      done += 1
      onProgress?.({ stage: 'draft', attempt: 1, done, total: DRAFT_TEMPERATURES.length })
      return article
    }),
  )

  if (drafted.ok.length === 0) {
    const first = drafted.errors[0]
    throw first instanceof Error ? first : new Error('生成失败')
  }

  const best = rankCandidates(drafted.ok.map(evaluate))[0]
  if (best.problems.length === 0) return finish(best.item)

  // 第三步：仍有硬伤，回喂问题做一次定向重写，再和原候选比较
  onProgress?.({ stage: 'revise', attempt: 2 })
  try {
    const { text, usage: callUsage } = await chatCompletion(
      [
        ...baseMessages,
        {
          role: 'user' as const,
          content: revisionRequest(best.problems, locateDefects(best.item.sentences, opts.level)),
        },
      ],
      { temperature: 0.8, maxTokens: ARTICLE_MAX_TOKENS, ...THINKING_OFF },
    )
    addUsage(callUsage)
    const repaired = evaluate(assemble(validate(parseLoose(text))))
    const final = rankCandidates([best, repaired])[0]
    return finish(final.item, final.problems)
  } catch {
    // 重写失败不影响交付：手上这篇有硬伤但能用，如实标注
    return finish(best.item, best.problems)
  }
}
