import type { BodyCompat, ParsedReply } from '@/api/protocols'

/**
 * 400 协商：从服务端的报错里推断「该怎么改参数」，以及把空正文翻译成人话。
 *
 * 从 `api/llm.ts` 的 `chatCompletion` 里的重试循环中搬出来的纯函数组：
 * 输入是报错文本 / 解析后的响应，输出是一个补丁或一句话，不碰网络、不碰状态。
 * 拆开之后这段可以单独读、单独验，重试循环也短了一半。
 */

/**
 * 从 400 的报错里推断该怎么改参数。
 *
 * 这个判断只做「服务端明确说了不行」的几种情形，不猜：
 * - 报错提到 max_completion_tokens → 把 max_tokens 换成它
 * - 报错提到 temperature → 去掉 temperature
 * - 报错提到 reasoning_effort / thinking → 去掉对应字段（部分国产网关不认）
 */
export function adaptCompat(detail: string, compat: BodyCompat): Partial<BodyCompat> | null {
  const msg = detail.toLowerCase()
  if (!compat.tokenField && msg.includes('max_completion_tokens')) {
    return { tokenField: 'max_completion_tokens' }
  }
  if (!compat.omitTemperature && msg.includes('temperature')) {
    return { omitTemperature: true }
  }
  // 不认 reasoning_effort 的服务端（部分国产网关）会直接 400
  if (compat.reasoningEffort && msg.includes('reasoning_effort')) {
    return { reasoningEffort: undefined }
  }
  // 不认 thinking 字段的服务端同样 400；去掉后落回服务端默认行为
  if (compat.thinkingDisabled && msg.includes('thinking')) {
    return { thinkingDisabled: undefined }
  }
  return null
}

/** 预算超过模型上限时，服务端会说「too large / exceeds」 */
export function looksLikeBudgetCap(detail: string): boolean {
  const msg = detail.toLowerCase()
  const aboutTokens = msg.includes('max_tokens') || msg.includes('max_completion_tokens')
  return aboutTokens && /(too large|exceed|maximum|at most|up to)/.test(msg)
}

/**
 * 把「正文为空」翻译成人能看懂的结论。
 *
 * 三种原因差别很大，以前一律报「模型返回了空内容，请检查模型名」，
 * 用户只能瞎猜；实际上绝大多数是第一种：
 * 1. 服务端瞬时抽风，200 但 content 为 ""（换一次就好）
 * 2. 推理模型把 max_tokens 全花在思维链上，正文还没开始就停了（放大额度再试）
 * 3. 地址填错，响应里根本没有 choices
 */
export function describeEmpty(reply: ParsedReply, payload: unknown): string {
  if (reply.truncated || reply.finishReason === 'length') {
    return '输出上限被用尽，模型还没写正文就停了（推理模型把额度花在思考上时会这样），已自动加大额度重试'
  }
  if (reply.reasoning) {
    return '模型只返回了思考过程，正文是空的。已自动重试一次，建议换个非推理模型'
  }
  const hasChoices = Array.isArray((payload as { choices?: unknown } | null)?.choices)
  const hint = hasChoices ? '' : '响应里没有 choices，先确认 Base URL 指向的是对话接口。'
  return `${hint}模型返回了空内容，已自动重试一次仍为空。这类多是服务端瞬时问题，稍后再试或换个模型`
}
