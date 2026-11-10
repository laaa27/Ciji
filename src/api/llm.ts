import { Capacitor, CapacitorHttp } from '@capacitor/core'

import {
  describeStatus,
  extractErrorMessage,
  PROTOCOLS,
  type BodyCompat,
  type ChatMessage,
  type ParsedReply,
  type RequestOptions,
} from '@/api/protocols'
import { useLlm, type LlmProfile } from '@/store/llm'
import { sleep } from '@/lib/async'

/**
 * 大模型调用。协议差异全部交给 api/protocols.ts，这里只负责三件事：
 * 取配置、选通道（原生 / 开发代理）、把失败翻译成人话。
 *
 * 通道选择沿用墨墨接口那套：
 * - 真机走 CapacitorHttp —— 原生 HTTP，不受 CORS 限制，也不需要用户配任何东西
 * - 浏览器开发走 Vite 中间件 /__llm —— BASE URL 是用户自己填的，没法用静态 proxy 配置
 */

export class LlmError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.status = status
  }
}

export type { ChatMessage }

let lastRaw: string | null = null

export function getLastLlmResponse(): string | null {
  return lastRaw
}

/** 开发期用的转发入口（见 vite.config.ts 的 llmProxy 插件） */
function proxyUrl(target: string): string {
  return `/__llm?url=${encodeURIComponent(target)}`
}

interface CallOptions extends RequestOptions {
  timeoutMs?: number
  /** 思考强度（推理模型才需要）。服务端不支持时会在 400 里说，届时自动去掉 */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** 明确关闭思考（DeepSeek 系 thinking.disabled）。与 reasoningEffort 互斥，同时给时它优先 */
  thinkingDisabled?: boolean
}

interface Reply {
  status: number
  payload: unknown
  raw: string
}

async function post(
  profile: LlmProfile,
  messages: ChatMessage[],
  opts: CallOptions,
  compat?: BodyCompat,
): Promise<Reply> {
  const codec = PROTOCOLS[profile.protocol]
  const url = codec.endpoint(profile.baseUrl)
  const headers = codec.headers(profile.apiKey)
  const body = codec.body(profile.model, messages, opts, compat)

  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.post({
      url,
      headers,
      data: body,
      connectTimeout: 15000,
      readTimeout: opts.timeoutMs ?? 120000,
    })

    const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null)
    let payload: unknown = res.data
    if (typeof res.data === 'string') {
      try {
        payload = JSON.parse(res.data)
      } catch {
        payload = null
      }
    }
    return { status: res.status, payload, raw }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120000)

  try {
    const res = await fetch(proxyUrl(url), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })

    const raw = await res.text()
    let payload: unknown = null
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = null
    }
    return { status: res.status, payload, raw }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new LlmError('生成超时了，换个短一点的词表再试')
    }
    throw new LlmError(
      e instanceof Error ? `网络请求失败：${e.message}` : '网络请求失败，检查 Base URL 是否可达',
    )
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* 重试与参数协商                                                       */
/* ------------------------------------------------------------------ */

/** 瞬时失败（空响应 / 429 / 5xx）的重试次数 */
const MAX_TRANSIENT = 1
const RETRY_DELAY_MS = 600
const MAX_TOKENS_CAP = 16000

/**
 * 按 profile 记住「协商过的参数」与「够用的输出预算」，只放内存。
 * 意义是不让每次生成都先撞一次 400、再因为预算不够白跑一轮。
 */
const compatCache = new Map<string, BodyCompat>()
const budgetFloor = new Map<string, number>()

/**
 * 从 400 的报错里推断该怎么改参数。
 *
 * 这个判断只做「服务端明确说了不行」的两种情形，不猜：
 * - 报错提到 max_completion_tokens → 把 max_tokens 换成它
 * - 报错提到 temperature → 去掉 temperature
 */
function adaptCompat(detail: string, compat: BodyCompat): Partial<BodyCompat> | null {
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
function looksLikeBudgetCap(detail: string): boolean {
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
function describeEmpty(reply: ParsedReply, payload: unknown): string {
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

/**
 * 发起一次对话，返回纯文本。
 * profile 传了就用传的（设置页「测试」用草稿配置），否则用当前生效的那份。
 *
 * 一次调用里可能发生三种重试，互不挤占额度：
 * 1. **参数协商**（400）：推理模型的 max_tokens / temperature 与普通模型不同，改一次参数重发
 * 2. **瞬时失败**（空响应 / 429 / 5xx）：等一会儿重发一次
 * 3. **预算不足**（空响应 + finish_reason=length）：把上限加大再来，并把结果记住
 */
export async function chatCompletion(
  messages: ChatMessage[],
  opts: CallOptions = {},
  profile?: LlmProfile,
): Promise<string> {
  const target = profile ?? useLlm.getState().active()
  if (!target) throw new LlmError('还没有添加大模型，去设置里加一个')

  const codec = PROTOCOLS[target.protocol]
  const cached = compatCache.get(target.id)
  let compat: BodyCompat = { ...(cached ?? {}) }
  // 缓存里已经有这个键（值为 undefined）说明上次被服务端拒绝过，别再试探
  if (opts.reasoningEffort && !(cached && 'reasoningEffort' in cached)) {
    compat.reasoningEffort = opts.reasoningEffort
  }
  if (opts.thinkingDisabled && !(cached && 'thinkingDisabled' in cached)) {
    compat.thinkingDisabled = true
  }

  // 上次被撑大过的预算直接沿用，省掉每次第一轮空跑
  const baseTokens = opts.maxTokens
  let maxTokens = Math.max(baseTokens ?? 0, budgetFloor.get(target.id) ?? 0) || undefined

  let transient = 0
  let compatFix = 0
  let budgetFellBack = false
  let lastError: LlmError | null = null

  for (let guard = 0; guard < 6; guard += 1) {
    const res = await post(target, messages, { ...opts, maxTokens }, compat)
    lastRaw = res.raw

    if (res.status < 200 || res.status >= 300) {
      const detail = extractErrorMessage(res.payload) ?? ''
      const brief = describeStatus(res.status)

      if (res.status === 400 && compatFix < 2) {
        // 预算超上限：退回原始值，别把用户的词表卡死
        if (!budgetFellBack && maxTokens && looksLikeBudgetCap(detail)) {
          maxTokens = baseTokens
          budgetFellBack = true
          continue
        }

        const patch = adaptCompat(detail, compat)
        if (patch) {
          compat = { ...compat, ...patch }
          compatCache.set(target.id, compat)
          compatFix += 1
          continue
        }
      }

      lastError = new LlmError([brief, detail.slice(0, 140)].filter(Boolean).join('：'), res.status)

      // 限流与服务端错误重试一次；鉴权、地址这类重试没意义
      if ((res.status === 429 || res.status >= 500) && transient < MAX_TRANSIENT) {
        transient += 1
        await sleep(RETRY_DELAY_MS)
        continue
      }
      throw lastError
    }

    const reply = codec.parse(res.payload)

    if (!reply.text.trim()) {
      lastError = new LlmError(describeEmpty(reply, res.payload), res.status)

      if (transient < MAX_TRANSIENT) {
        transient += 1
        // 额度被思维链吃光时，直接把上限撑大（max_tokens 只是上限，没用到不额外收费）
        if (reply.truncated || reply.finishReason === 'length') {
          maxTokens = Math.min(Math.max((maxTokens ?? 2000) * 2, 8000), MAX_TOKENS_CAP)
        }
        await sleep(RETRY_DELAY_MS)
        continue
      }
      throw lastError
    }

    if (reply.truncated) {
      throw new LlmError('输出被长度上限截断了，换短一点的词表或换支持更长输出的模型')
    }

    // 这次是靠加大预算才成的，记住它，下一轮直接用
    if (maxTokens && maxTokens > (baseTokens ?? 0)) {
      budgetFloor.set(target.id, maxTokens)
    }

    return reply.text
  }

  throw lastError ?? new LlmError('生成失败，请重试')
}

/** 设置页「测试连接」：发一句最短的请求；可传草稿配置，保存前先验证 */
export async function testConnection(profile?: LlmProfile): Promise<string> {
  const reply = await chatCompletion(
    [{ role: 'user', content: '只回复两个字：正常' }],
    { maxTokens: 32, temperature: 0, timeoutMs: 30000 },
    profile,
  )
  return reply.trim().slice(0, 20)
}
