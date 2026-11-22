/**
 * 训练栏目的数据类型。
 *
 * 数据来自 scripts/import-training.py 导出的静态 JSON（`public/training/`），
 * 结构照着题库的原始分层：套卷 → 题型 → 篇目 → 句 / 题。
 * 这一层只管类型与判定，不碰 fetch、不碰 DOM。
 */

export type TrainingLevel = 'cet4' | 'cet6' | 'kaoyan'

/** 一句原文。校准过的段每句带 zh（LLM 归属写入，见 scripts/calibrate-zh-align.mjs） */
export type TrainingSentence = {
  en: string
  /** 本句的中文译文（仅校准过的段落有；未校准的段译文在 para.zh） */
  zh?: string
  /** 信息匹配段落的 A/B/C 标号 */
  label?: string
}

export type TrainingOption = { key: string; text: string }

/** 解析。题库原文按【】分节，导入时切成这几块，切不开的整段留在 raw */
export type TrainingAnalysis = {
  answer?: string
  /** 题型判定：细节题 / 推断题 / 主旨题… */
  qtype?: string
  /** 判型理由 */
  judge?: string
  /** 题干拆句 */
  split?: string
  /** 定位：原文出处（部分条目带中英对照） */
  locate?: string
  /** 七选五 / 小标题：补进空位的正确句（英文 + 中译） */
  correct?: string
  /** 七选五 / 小标题：这个空为什么存在（上下文缺口分析） */
  gap?: string
  /** 七选五 / 小标题：判断线索（代词指代、逻辑连接词等） */
  clue?: string
  /** 逐选项归因：verdict 是「与原文相反 / 无中生有 / 以偏概全」这类判定 */
  options?: { key: string; verdict: string; note: string }[]
  note?: string
  raw?: string
}

export type TrainingQuestion = {
  no: number
  /** mcq / blank / match / essay / translation */
  type: string
  stem?: string
  options?: TrainingOption[]
  answer?: string
  /** 答案出处（哪个解析文件第几页），来自题库的 answer_source */
  source?: string
  analysis?: TrainingAnalysis
}

/** 一段：若干句 + 这一段的中译（题库的译文是段级的，不是句级） */
export type TrainingPara = {
  sents: TrainingSentence[]
  zh?: string
}

/**
 * 新题型变体（考研 matching 按结构化判定，见 import-training.py 的 matching_variant）。
 * matching = 信息匹配；gapfill = 七选五；headings = 小标题；opinions = 观点概括；
 * ordering = 排序题；tf = 判断正误。
 */
export type MatchingKind =
  | 'matching'
  | 'ordering'
  | 'tf'
  | 'headings'
  | 'opinions'
  | 'gapfill'

/** 排序题的链槽：原卷已给定的段落（given）或待答槽位（no = 题号） */
export type ChainSlot = { given?: string; no?: number }

export type TrainingPassage = {
  id: string
  paras: TrainingPara[]
  questions: TrainingQuestion[]
  /** 选词填空的待选词库（15 词，填 10 空） */
  bank?: TrainingOption[]
  /** 题面要求（写作的 Directions、翻译的中文原文）。不掺进正文，正文要能逐词点 */
  brief?: string
  /** 附注（写作范文的中译等） */
  notes?: string[]
  /** 新题型变体（仅 matching 节有） */
  kind?: MatchingKind
  /** 排序题的固定链（given 槽与待答槽的排布顺序） */
  chain?: ChainSlot[]
}

export type TrainingSection = {
  id: string
  label: string
  passages: TrainingPassage[]
  /** 题型整体讲解（写作范文点评、翻译参考英译说明） */
  notes?: string[]
}

export type TrainingPaper = {
  key: string
  level: TrainingLevel
  year: number
  month: number
  setNo: number
  label: string
  sections: TrainingSection[]
}

/** 列表页只需要索引，不读全文 */
export type TrainingIndexItem = {
  key: string
  level: TrainingLevel
  year: number
  month: number
  setNo: number
  label: string
  sections: { id: string; label: string; questions: number }[]
}

export const LEVELS: { key: TrainingLevel; label: string }[] = [
  { key: 'cet4', label: '四级' },
  { key: 'cet6', label: '六级' },
  { key: 'kaoyan', label: '考研' },
]

/** 能当场判分的题：有选项、有答案、且答案是选项里的一个 */
export function isObjective(q: TrainingQuestion): boolean {
  if (!q.options || q.options.length === 0 || !q.answer) return false
  return q.options.some((o) => o.key === q.answer)
}

/** 这一篇里有没有中文（决定「译文」开关要不要出现） */
export function hasTranslation(p: TrainingPassage): boolean {
  return (
    p.paras.some((para) => Boolean(para.zh)) ||
    p.paras.some((para) => para.sents.some((s) => Boolean(s.zh)))
  )
}

/**
 * 段译里混进的解析页残渣：「Questions 46 to 50 are based on …」。
 * 四六级的译文是从解析页排版里抠的，偶尔把下一题的引导句也带了进来。
 */
const ZH_JUNK_RE = /\s*Questions?\s+\d+[\s\S]*$/i

/** 去掉段译尾部的解析残渣，返回干净的译文（可能为空串） */
export function cleanParaZh(zh: string): string {
  return zh.replace(ZH_JUNK_RE, '').trim()
}

/**
 * 段译切句。两个实测修出来的坑（全语料 2340 段，普通切法对齐率 82.8%，这套 93.8%）：
 * - 引号闭合原子化：`……。”` 这种结构不能切在 。 后面，否则闭引号会掉出来成孤立碎片；
 * - 分号不切：译者爱把一个英文长句拆成「A；B；C；D。」的分句串，按分号切句数必然膨胀。
 */
const ZH_SPLIT_RE = /(?<=[。！？!?])(?![”’"'])|(?<=[。！？!?][”’"'])/

/**
 * 段译逐句对齐：把段译按句切开，与段内英文句一一配对。
 * 校准过的段（每句已带 zh）直接用句级译文；否则按标点切段译。
 * 切完句数对不上（翻译把一句拆成两句、或几句并成一句）就放弃 —— 返回 null，
 * 调用方回退到整段译文，宁可退回原样式，也不能把错位的译文扣到错误的句子上。
 */
export function alignParaZh(para: TrainingPara): string[] | null {
  const perSent = para.sents.map((s) => s.zh)
  if (perSent.every(Boolean)) return perSent.map((s) => s ?? '')

  // 只有部分句有译文：考研翻译就是这种 —— 英语一只有 5 个划线句有参考答案，
  // 其余句子本来就不该有译文。有就显示、没有留空，别拿整段译文去凑
  if (perSent.some(Boolean) && !para.zh) return perSent.map((s) => s ?? '')

  const zh = para.zh
  if (!zh) return null
  const parts = cleanParaZh(zh)
    .split(ZH_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length === para.sents.length ? parts : null
}

/** 选词填空：句子里带 `__(26)__` 空位 */
export const BLANK_RE = /__\((\d+)\)__/

export function isCloze(p: TrainingPassage): boolean {
  return Boolean(p.bank && p.bank.length > 0)
}

/** 一次作答的成绩：答对几题、共几道可判分的题 */
export function scoreOf(
  passage: TrainingPassage,
  answers: Record<number, string>,
): { right: number; total: number; rate: number } {
  const judged = passage.questions.filter(isObjective)
  const right = judged.filter((q) => answers[q.no] === q.answer).length
  const total = judged.length
  return { right, total, rate: total > 0 ? Math.round((100 * right) / total) : 0 }
}

/** 题量汇总，列表页显示「阅读理解 · 5 题」用 */
export function sectionQuestionCount(s: TrainingSection): number {
  return s.passages.reduce((n, p) => n + p.questions.length, 0)
}

/**
 * 阅读题的题型族。
 *
 * 四六级的「阅读理解」在卷面上是 Section C 的 Passage One / Two，
 * 题库却拆成 `reading1` / `reading2` 两个题型、各一篇。凡是要「把这两节当成一件事」
 * 的地方（连续编号、篇目总数、标题是否标「第 N 篇」）都必须走这里，
 * 别在 JSX 里重复写 `id === 'reading1' || id === 'reading2'`——换题型就会漏改。
 */
export function isReadingSection(s: Pick<TrainingSection, 'id'>): boolean {
  return s.id === 'reading1' || s.id === 'reading2'
}

/**
 * 篇目序号。
 *
 * 卷面上同一道阅读题的两篇要连续编号（四六级得到 1、2；考研的 reading1 自带四篇则 1~4），
 * 其余题型按各自节内顺序编号。列表里两行都叫「阅读理解 · 5 题」时，靠这个区分谁是谁。
 */
export function readingOrdinals(sections: TrainingSection[]): Map<string, number> {
  const map = new Map<string, number>()
  let reading = 0
  for (const sec of sections) {
    const isReading = isReadingSection(sec)
    sec.passages.forEach((p, i) => {
      if (isReading) {
        reading += 1
        map.set(p.id, reading)
      } else {
        map.set(p.id, i + 1)
      }
    })
  }
  return map
}

/**
 * 阅读题型一共有几篇（四六级 2 篇、考研 4 篇）。
 * 只有一篇的题型不标「第 1 篇」——那是噪音。
 */
export function readingCount(sections: TrainingSection[]): number {
  return sections
    .filter(isReadingSection)
    .reduce((n, s) => n + s.passages.length, 0)
}

/**
 * 按年份分组：一百多套平铺下来，光靠「2026 年 6 月 · 第 3 套」这行字分不清年与年的界线。
 * 分组之后每一年的第一行就是分界，眼睛有落点。年份倒序（新的在上）。
 */
export function groupByYear<T extends { year: number }>(items: T[]): {
  years: number[]
  byYear: Map<number, T[]>
} {
  const byYear = new Map<number, T[]>()
  for (const item of items) {
    const arr = byYear.get(item.year)
    if (arr) arr.push(item)
    else byYear.set(item.year, [item])
  }
  return { years: [...byYear.keys()].sort((a, b) => b - a), byYear }
}
