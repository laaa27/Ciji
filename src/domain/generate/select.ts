/**
 * 并行候选与择优。
 *
 * 为什么是并行：现在的慢不是模型慢，是结构慢 —— 一次提纲 + 一次成文 + 六成概率再来一次**串行**重写。
 * 重试必然加时间，采样只加 token。把「不合格就重掷」换成「一次多跑几路、本地挑最好的」，
 * 墙钟从「两轮」降到「一轮」，质量反而更好（多篇里挑胜过一篇赌运气）。
 *
 * 参考：TSAR 2025 的 CEFR 简化竞赛用「自动判级 + 最多 5 轮修正」把 RMSE 从 0.4583 降到 0.122，
 * 说明有客观判据时多轮/多路都远胜单次生成；而散文类用模型当评委时 N 过大反而变差
 * （评委误差被 argmax 放大），所以这里取 K=4，用**确定性规则**打分而不是让模型当评委。
 */

/**
 * 并行路数与温度阶梯。
 *
 * 4 路而非 8 路：用历史稿件做的模拟里，K=4 已经拿到约 −30% 的综合距离，K=8 只再多 5~9 个点，
 * 而 token 是线性涨的。温度拉开是为了让候选真的有差异 —— 同一温度跑 4 次大概率得到 4 篇近似稿，
 * 那等于白花三份钱。
 */
export const DRAFT_COUNT = 4
export const DRAFT_TEMPERATURES = [0.7, 0.85, 1.0, 1.05]

/** 一路候选：内容 + 硬伤 + 到规格的距离 */
export interface Candidate<T> {
  item: T
  /** 审计给出的硬伤（篇幅 / 缺词 / 句式 / 文体），空数组表示合格 */
  problems: string[]
  /** metrics.ts 的距离，越小越像真题 */
  distance: number
}

/**
 * 排序规则：先按硬伤，再按距离。
 *
 * 为什么要分两段：硬伤是「不能交」的（缺词、残篇），距离是「不够好」的。
 * 一篇距离极近但缺两个目标词的稿子，不能因为"形状好看"就胜过合格的那篇。
 */
export function rankCandidates<T>(cands: Candidate<T>[]): Candidate<T>[] {
  return [...cands].sort((a, b) => {
    const cleanA = a.problems.length === 0 ? 0 : 1
    const cleanB = b.problems.length === 0 ? 0 : 1
    if (cleanA !== cleanB) return cleanA - cleanB
    if (a.problems.length !== b.problems.length) return a.problems.length - b.problems.length
    return a.distance - b.distance
  })
}

/**
 * 并发跑一组任务。
 *
 * 用 allSettled 的理由：4 路里挂一路（限流 / 超时）不该让整篇作废 ——
 * 剩下 3 篇照样能挑。全部失败时把错误一起返回，由调用方决定报哪一个，
 * 这样「四路都超时」仍然给出人话，而不是一句空泛的失败。
 */
export async function runParallel<T>(
  tasks: (() => Promise<T>)[],
): Promise<{ ok: T[]; errors: unknown[] }> {
  const settled = await Promise.allSettled(tasks.map((t) => t()))
  const ok: T[] = []
  const errors: unknown[] = []
  for (const s of settled) {
    if (s.status === 'fulfilled') ok.push(s.value)
    else errors.push(s.reason)
  }
  return { ok, errors }
}
