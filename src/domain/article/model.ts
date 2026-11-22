import type { ArticleLevel, Genre } from '@/domain/prompts'

/**
 * 文章的数据模型（纯类型 + 常量标签）。
 *
 * 从 `domain/article.ts` 拆出来的：模型、选词规则、生成编排、文本导出原先住在一个
 * 文件里，调用方为了拿一个类型就把 `api/llm` 与 `store/llm` 一起拉进依赖图。
 * 这里只有类型，**零运行时依赖**，`data/` 层也可以安心引用。
 */

export type ArticleMode = 'weak' | 'new' | 'all'

/** 难度类型、标签、提示词全部住在 `domain/prompts.ts` —— 那边零依赖 */
export type { ArticleLevel, Genre, Outline } from '@/domain/prompts'

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

/**
 * 这一篇实际花了多少 token。
 *
 * 为什么要存下来而不是只打日志：提示词结构一旦把静态部分前置，缓存命中会从 0 变成大头，
 * 而这个变化**只体现在 `cached` 上**——生成结果看不出来，速度也只快一点点。
 * 不落库就只能靠翻服务商后台对账，等于没法验证。
 *
 * `requests` 比 `calls` 大是可诊断的信号：说明中间撞过 400 协商或截断加码，
 * 那一刻整轮请求是重发的，钱也重付了一次。
 */
export interface ArticleUsage {
  prompt: number
  completion: number
  /** 输入里命中提示词缓存的前缀 token */
  cached: number
  /** 逻辑调用次数（提纲 1 + 成文 1~2） */
  calls: number
  /** 实际 HTTP 请求数 */
  requests: number
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
  /** 本篇的 token 用量（老文章没有这个字段，界面按没有处理） */
  usage?: ArticleUsage
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
