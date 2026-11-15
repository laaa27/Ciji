/**
 * 训练栏目的数据类型。
 *
 * 数据来自 scripts/import-training.py 导出的静态 JSON（`public/training/`），
 * 结构照着题库的原始分层：套卷 → 题型 → 篇目 → 句 / 题。
 * 这一层只管类型与判定，不碰 fetch、不碰 DOM。
 */

export type TrainingLevel = 'cet4' | 'cet6' | 'kaoyan'

/** 一句原文。听力带 zh（题库本来就给了逐句中英），阅读暂时没有 */
export type TrainingSentence = {
  en: string
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
  if (p.paras.some((para) => Boolean(para.zh))) return true
  return p.paras.some((para) => para.sents.some((s) => Boolean(s.zh)))
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
