import type { ParsedReply } from '@/api/protocols'

/**
 * 输出预算的加码与回退。
 *
 * 从 `api/llm.ts` 的 `chatCompletion` 里搬出来的：原先「够不够翻倍」「到没到顶」
 * 「上次撑大过多少」三个判断和重试循环缠在一起，改一处要读懂另外两处。
 * 这里只有算术，没有任何 IO。
 */

/**
 * 单次调用最多能要到多少输出额度。
 *
 * 抬到 32000 是因为：思考模式默认开，提示词变长后实测思考能吃掉 8000~30000 字，
 * 8192 的额度会在正文开始前就被耗尽（finish=length、content 为空）。
 * deepseek-flash 实测接受 max_tokens=32000（不会 400），所以留足余量；
 * 服务端若真有更低的硬顶，400 会走 looksLikeBudgetCap 退回原值，不会卡死。
 */
export const MAX_TOKENS_CAP = 32000

/** 因为「额度被用尽」而加码重试的次数上限（每次翻倍） */
export const MAX_BUDGET_ESCALATIONS = 2

/** 这次是不是「额度被吃光」：截断，或 finish_reason=length */
export function isStarved(reply: Pick<ParsedReply, 'truncated' | 'finishReason'>): boolean {
  return reply.truncated || reply.finishReason === 'length'
}

/**
 * 下一档预算。已经加码到上限、或翻倍后没有实际增长时返回 null（调用方据此如实报错）。
 * `current` 未定义时按 2000 起翻。
 */
export function nextBudget(current: number | undefined, escalations: number): number | null {
  if (escalations >= MAX_BUDGET_ESCALATIONS) return null
  const next = Math.min(Math.max((current ?? 2000) * 2, 8000), MAX_TOKENS_CAP)
  if (next <= (current ?? 0)) return null
  return next
}

/**
 * 本轮实际用的预算：上次靠加大预算成功过就直接沿用，省掉每次第一轮空跑。
 * 两者都没有时为 undefined（交给协议层决定默认值）。
 */
export function resolveBudget(
  base: number | undefined,
  floor: number | undefined,
): number | undefined {
  return Math.max(base ?? 0, floor ?? 0) || undefined
}
