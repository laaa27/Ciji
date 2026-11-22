import type { TodaySnapshot } from '@/domain/collect'
import type { ArticleLevel } from '@/domain/prompts'

import type { WordCandidate, WordKind } from './model'

/**
 * 选词规则：一天的快照 + 当天已用词 → 候选列表 / 默认勾选 / 超限裁剪。
 *
 * 从 `domain/article.ts` 拆出来的。这三件事**不碰模型、不碰网络**，
 * 是生成页里唯一值得（也唯一能够）单测的部分；留在原处时整个文件依赖
 * `api/llm` + `store/llm`，在 node 里跑不起来。
 */

/** 新生成时可选的难度（雅思用不上，从选项里去掉） */
export const LEVELS: ArticleLevel[] = ['cet4', 'cet6', 'kaoyan']

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
