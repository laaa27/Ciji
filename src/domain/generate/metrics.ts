/**
 * 生成候选的「像不像真题」度量。
 *
 * 为什么需要它：审计只能回答「合格 / 不合格」，回答不了「哪一篇更好」。
 * 并行生成多篇之后必须有个能排序的标量，否则选择环节无从下手。
 *
 * ⚠️ 判定口径与 `scripts/analyze-difficulty.py` 保持一致（那边是离线对照用的判定器）。
 * 两边各有一份实现是历史遗留：那个脚本要能独立跑在任何环境的 python 上，
 * 而这里要能在 app 里对**已经切好的句子数组**直接算，不重新切句。
 * 改规则时两边必须一起改，否则离线实验的结论对 app 不成立。
 */
import { countWords, wordPattern } from '@/lib/text'
import { LEVEL_SPEC, type ArticleLevel } from '@/domain/prompts'

/** 真题实测锚点：2023 年四六级与考研英语二语料（详见 `词迹-生成难度偏差分析.md`） */
const CORPUS: Record<ArticleLevel, { simple: number; nest: number; sd: number }> = {
  cet4: { simple: 40.2, nest: 20.4, sd: 10.0 },
  cet6: { simple: 38.0, nest: 21.5, sd: 7.9 },
  kaoyan: { simple: 33.2, nest: 27.4, sd: 9.8 },
  // 雅思档已不可新生成，留个中性值只为类型完整
  ielts: { simple: 38, nest: 22, sd: 9 },
}

/** 从句标记：关系词（不在句首）、从属连词、逗号后的非谓语 */
const RELATION = /\b(which|who|whom|whose|where|when)\b/gi
const SUBORDINATOR =
  /\b(that|although|though|because|since|if|unless|while|whereas|whether|before|after|until|once|provided|than|so that|such that|even though)\b/gi
const NONFINITE = /,\s+(having\s+)?[a-z]+(ing|ed)\b|,\s+to\s+[a-z]+\b/gi
/** and/but/or/yet/so 后面跟第二个谓语 —— 并列句不算简单句 */
const COORD_VERB = new RegExp(
  String.raw`,?\s+(and|but|or|yet|so)\s+[A-Za-z]+\s+` +
    String.raw`(is|are|was|were|has|have|had|will|would|can|could|may|might|must|do|does|did|[a-z]+ed|[a-z]+s)\b`,
  'i',
)
const NOMINAL = /(tion|sion|ment|ance|ence|ity|ness|ism|ship)$/i

export interface ArticleMetrics {
  words: number
  sentences: number
  avg: number
  sd: number
  longest: number
  /** 语法简单句占比（0~1） */
  simple: number
  /** 零从句句占比（0~1） */
  zeroClause: number
  /** 每句平均从句标记数 */
  marksPerSent: number
  /** ≥2 层嵌套句占比（0~1） */
  nested: number
  /** ≤12 词的句子数 */
  short: number
  /** ≥longFrom 词的句子数 */
  long: number
  /** 名词化 / 百词 */
  nominal: number
}

function clauseMarks(s: string): number {
  const count = (rx: RegExp) => (s.match(rx) ?? []).length
  // 关系词在句首是疑问句/关系从句开头，不算从句标记（与 python 的 (?<!^) 同义）
  const rel = count(RELATION) - (/^(which|who|whom|whose|where|when)\b/i.test(s.trim()) ? 1 : 0)
  return Math.max(0, rel) + count(SUBORDINATOR) + count(NONFINITE)
}

function isSimple(s: string): boolean {
  return clauseMarks(s) === 0 && !COORD_VERB.test(s)
}

export function measure(sentences: { en: string }[], level: ArticleLevel): ArticleMetrics {
  const spec = LEVEL_SPEC[level]
  const lens = sentences.map((s) => countWords(s.en))
  const n = Math.max(1, lens.length)
  const words = lens.reduce((a, b) => a + b, 0)
  const avg = words / n
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - avg) ** 2, 0) / n)

  const marks = sentences.map((s) => clauseMarks(s.en))
  const tokens = sentences.flatMap((s) => s.en.match(wordPattern()) ?? [])

  return {
    words,
    sentences: lens.length,
    avg,
    sd,
    longest: lens.reduce((a, b) => Math.max(a, b), 0),
    simple: sentences.filter((s) => isSimple(s.en)).length / n,
    zeroClause: marks.filter((m) => m === 0).length / n,
    marksPerSent: marks.reduce((a, b) => a + b, 0) / n,
    nested: marks.filter((m) => m >= 2).length / n,
    short: lens.filter((l) => l <= 12).length,
    long: lens.filter((l) => l >= spec.longFrom).length,
    nominal: (100 * tokens.filter((w) => w.length > 5 && NOMINAL.test(w)).length) / Math.max(1, tokens.length),
  }
}

/**
 * 到「真题形状」的加权距离，越小越好。
 *
 * 每项的容差是「偏离多少记 1 分」，参考的是实测波动：
 * 篇幅偏离中位 12%、平均句长偏离 1.5 词、简单句占比偏离 5 个百分点、
 * 句长标准差偏离 2、嵌套密度偏离 6 个百分点 —— 都是「肉眼能看出来但不至于换一篇」的量级。
 * 分布三项（标准差 / 嵌套 / 简单句）和篇幅各占一份权重：前三项正是手调提示词治不好的老病，
 * 不单独加权就等于放任它们不变。
 */
export function distance(m: ArticleMetrics, level: ArticleLevel): number {
  const spec = LEVEL_SPEC[level]
  const corpus = CORPUS[level]
  const mid = (spec.words[0] + spec.words[1]) / 2
  const avgMid = (spec.avgSentence[0] + spec.avgSentence[1]) / 2

  const parts = [
    Math.abs(m.words - mid) / (0.12 * mid),
    Math.abs(m.avg - avgMid) / 1.5,
    Math.abs(m.simple * 100 - corpus.simple) / 5,
    Math.abs(m.sd - corpus.sd) / 2,
    Math.abs(m.nested * 100 - corpus.nest) / 6,
    Math.max(0, spec.veryLong - m.long) * 0.5,
    Math.max(0, spec.shortSents - m.short) * 0.3,
  ]
  return parts.reduce((a, b) => a + b, 0) / parts.length
}
