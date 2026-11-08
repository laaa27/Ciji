import { Capacitor, CapacitorHttp } from '@capacitor/core'

import {
  describeStatus,
  extractErrorMessage,
  PROTOCOLS,
  type ChatMessage,
  type ParsedReply,
  type RequestOptions,
} from '@/api/protocols'
import { useLlm, type LlmProfile } from '@/store/llm'

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
): Promise<Reply> {
  const codec = PROTOCOLS[profile.protocol]
  const url = codec.endpoint(profile.baseUrl)
  const headers = codec.headers(profile.apiKey)
  const body = codec.body(profile.model, messages, opts)

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

/** 空响应多为服务端瞬时问题，等一会儿再来一次通常就好 */
const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 600
const MAX_TOKENS_CAP = 8000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
    return '输出上限被用尽，模型还没写正文就停了（推理模型把额度花在思考上时会这样）。已自动加大额度重试一次'
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
 */
export async function chatCompletion(
  messages: ChatMessage[],
  opts: CallOptions = {},
  profile?: LlmProfile,
): Promise<string> {
  const target = profile ?? useLlm.getState().active()
  if (!target) throw new LlmError('还没有添加大模型，去设置里加一个')

  const codec = PROTOCOLS[target.protocol]
  let maxTokens = opts.maxTokens
  let lastError: LlmError | null = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { status, payload, raw } = await post(target, messages, { ...opts, maxTokens })
    lastRaw = raw

    if (status < 200 || status >= 300) {
      const detail = extractErrorMessage(payload)
      const brief = describeStatus(status)
      const err = new LlmError([brief, detail?.slice(0, 140)].filter(Boolean).join('：') || `请求失败（${status}）`, status)

      // 限流和服务端错误重试一次；鉴权、地址这类错误重试没意义
      if ((status === 429 || status >= 500) && attempt < MAX_ATTEMPTS - 1) {
        lastError = err
        await sleep(RETRY_DELAY_MS)
        continue
      }
      throw err
    }

    const reply = codec.parse(payload)

    if (!reply.text.trim()) {
      lastError = new LlmError(describeEmpty(reply, payload), status)

      if (attempt < MAX_ATTEMPTS - 1) {
        // 预算被思维链吃光时，把上限翻倍再来（否则只是等一会儿重试）
        if (reply.truncated || reply.finishReason === 'length') {
          maxTokens = Math.min((maxTokens ?? 2000) * 2, MAX_TOKENS_CAP)
        }
        await sleep(RETRY_DELAY_MS)
        continue
      }
      throw lastError
    }

    if (reply.truncated) {
      throw new LlmError('输出被长度上限截断了，换短一点的词表或换支持更长输出的模型')
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
