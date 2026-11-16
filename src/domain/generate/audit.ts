import { lemmaCandidates } from '@/lib/lemma'
import { countWords, countWordsIn, wordPattern } from '@/lib/text'
import { LEVEL_SPEC, type ArticleLevel, type Genre } from '@/domain/prompts'

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
 *
 * 与 metrics.ts 同居 generate/ 目录：审计（硬伤）与距离（像不像真题）是择优的两把尺。
 */

/** 名词化后缀：与 scripts/analyze-difficulty.py 的口径一致，方便两边数字对得上 */
const NOMINAL_SUFFIX = /(tion|sion|ment|ance|ence|ity|ness|ism|ship)$/i
/** 真题名词化 2.1~3.5 / 百词；超过说明写成了学术摘要而不是考试阅读 */
const MAX_NOMINAL_PER_100 = 6
/** 「, which / , who」非限制性定语从句最多几句：真题四级一篇约 0.4 句、考研约 1.7 句 */
const MAX_NONRESTRICTIVE = 3
/** 主张表述：议论文靠它立论，说明文里出现就是跑偏 */
const CLAIM_WORDS = /\b(should|must|ought to|need to|had better)\b/gi
/** 说明文允许的「应该」处数（留给引述他人观点的余地） */
const MAX_EXPOSITORY_CLAIMS = 2

/**
 * 短语对偶框架（rather than / instead of / not … but … / unlike）的合计上限。
 *
 * 为什么单独立一条：实测 rather than 篇均 0.95 / 2.12 / 1.92 次，真题只有 0.20 / 0.33 / 0.20；
 * 六级 31/32 篇都出现、12 篇 3 次以上（最多 5 次）。提示词里已经写了「最多 2 处」，
 * 但 ", which" 那条的经验是：**只靠措辞拦不住，得有个能数的出口**。
 *
 * 按框架族而不是按单词封：只封 rather than 会漂到 instead of / not … but …（真题里这些同样几乎不用）。
 * 上限取 2 而不是 1：上限 1 会打回 69% 的六级稿，重写率不可接受。
 */
const MAX_CONTRAST_FRAME = 2
/** 词面型对偶（短语级，不含 not … but …） */
const CONTRAST_PHRASE = /\b(rather than|instead of|unlike)\b/gi
/** 句式型对偶：not … but … 必须跨词匹配，所以单独一条 */
const CONTRAST_ANTITHESIS = /\bnot\b[^.;]{0,60}\bbut\b/gi

/** 校验哪些目标词没出现在正文里 */
export function missingWords(article: {
  sentences: { en: string }[]
  targetWords: string[]
}): string[] {
  const text = article.sentences.map((s) => s.en).join(' ')
  // 与渲染、词数统计共用同一个口径：撇号与连字符的切法必须一致，
  // 否则正文里明明写着 `a pharaoh's mask`，判定侧却只看到 `pharaoh` + `s` 两个碎词
  const tokens = text.match(wordPattern()) ?? []

  // 每个 token 的全部还原候选（rests → [rests, rest]），既做单词条集合，也保住位置
  const lemmas: string[][] = tokens.map((token) => lemmaCandidates(token))
  const normalized = new Set(lemmas.flat())

  return article.targetWords.filter((w) => !isCovered(w, lemmas, normalized))
}

/**
 * 目标词是否被正文覆盖。
 *
 * 单词：任一侧的还原候选在另一边出现就算用上（rests / rest 都算覆盖了 rest）。
 * 两侧都要展开——目标词本身也可能是变形或所有格（勾的是 `pharaoh`，正文写的是
 * `pharaoh's` 才算用上；以前只展开正文那一侧，于是永远判定为「没用上」）。
 *
 * 短语（rest on / be meant to）：在词元序列里找一个**连续窗口**逐词覆盖——
 * 原先把它当整体字符串查集合，永远查不到，「明明用上了却说未用到」；
 * 逐词覆盖后，rests on 覆盖 rest on，was meant to（was→be）覆盖 be meant to。
 */
function isCovered(word: string, lemmas: string[][], normalized: Set<string>): boolean {
  const words = word.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'").trim().split(/\s+/)

  if (words.length === 1) {
    return lemmaCandidates(words[0]).some((c) => normalized.has(c))
  }

  if (words.length > lemmas.length) return false
  outer: for (let i = 0; i + words.length <= lemmas.length; i += 1) {
    for (let j = 0; j < words.length; j += 1) {
      const cands = lemmaCandidates(words[j])
      if (!cands.some((c) => lemmas[i + j].includes(c))) continue outer
    }
    return true
  }
  return false
}

export function auditArticle(
  a: { sentences: { en: string }[]; targetWords: string[] },
  level: ArticleLevel,
  genre: Genre,
): string[] {
  const spec = LEVEL_SPEC[level]
  const problems: string[] = []

  const words = countWordsIn(a.sentences)
  // 0.85 折：实测 0.9 折把「差 2~9 词」的文章也打回去重写（333/340 vs 下限 342），
  // 而真塌篇（79/126/129 词）照样拦得住。重写率从 58% 降到 ~25%，省下的是一整轮生成。
  const floor = Math.round(spec.words[0] * 0.85)
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

  // 平均句长只卡下限：句子写得比目标短才是问题（四级会写成 13 词/句那样过于简单）。
  // 上界不判不合格——实测模型经常写到 24~30 词（目标 18~26），这是"偏长但可读"，
  // 为它重生成一整轮不值当（12 篇实测里 3 篇被这条打回，重写后也没更好）。
  const avg = words / Math.max(1, lens.length)
  const [aMin] = spec.avgSentence
  if (avg < aMin - 2) {
    problems.push(`平均句长 ${avg.toFixed(1)} 词（目标 ${spec.avgSentence[0]}~${spec.avgSentence[1]}）`)
  }

  // 名词化密度：分词口径与其他地方保持一致（撇号、连字符不能各切各的）
  const tokens = a.sentences.map((s) => s.en).join(' ').match(wordPattern()) ?? []
  const nominal = tokens.filter((w) => w.length > 5 && NOMINAL_SUFFIX.test(w)).length
  const nominalPct = (100 * nominal) / Math.max(1, tokens.length)
  if (nominalPct > MAX_NOMINAL_PER_100) {
    problems.push(`名词化过密（每百词 ${nominalPct.toFixed(1)} 个，上限 ${MAX_NOMINAL_PER_100}）`)
  }

  const passive = a.sentences.filter((s) =>
    /\b(is|are|was|were|be|been|being)\s+([a-z]+ed|[a-z]+en)\b/i.test(s.en),
  ).length
  const passivePct = (100 * passive) / Math.max(1, lens.length)
  // 被动改成区间：真题是「四级最多、考研最少」（19.8 / 8.2 / 5.8），只写上限会让方向反过来。
  // 下限只对说明文判 —— 说明文天然多定义句和状态陈述，议论文本来就少被动。
  const [passiveMin, passiveMax] = spec.passive
  if (genre === 'expository' && passivePct < passiveMin) {
    problems.push(`被动句太少（${passivePct.toFixed(0)}% 的句子，说明文至少要 ${passiveMin}%）`)
  }
  if (passivePct > passiveMax) {
    problems.push(`被动句过多（${passivePct.toFixed(0)}% 的句子，上限 ${passiveMax}%）`)
  }

  // 用同一个模板反复凑长句：实测一篇四级稿 15 句里有 6 句是「, which …」，
  // 真题四级 2.4% 的句子有这种结构（一篇约 0.4 句）。超过 3 处就是模板化，重写。
  const nonRestrictive = a.sentences.filter((s) => /,\s+(which|who)\b/i.test(s.en)).length
  if (nonRestrictive > MAX_NONRESTRICTIVE) {
    problems.push(`「, which/who」用得太密（${nonRestrictive} 句，上限 ${MAX_NONRESTRICTIVE}）`)
  }

  // 对偶框架：这是比 ", which" 更隐蔽的模板——每处单看都通顺，连起来读就是一个人只有一招
  const fullText = a.sentences.map((s) => s.en).join(' ')
  const frames =
    (fullText.match(CONTRAST_PHRASE) ?? []).length + (fullText.match(CONTRAST_ANTITHESIS) ?? []).length
  if (frames > MAX_CONTRAST_FRAME) {
    problems.push(
      `对偶句式过多（rather than / instead of / not…but… 共 ${frames} 处，上限 ${MAX_CONTRAST_FRAME}）`,
    )
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
