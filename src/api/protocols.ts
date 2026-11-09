/**
 * 两种协议（OpenAI 兼容 / Anthropic）的请求构造与响应解析。
 *
 * 单独抽成纯函数模块，好处有三个：
 * 1. 不依赖 Capacitor，可以在 node 里直接跑断言（`node --experimental-strip-types`）
 * 2. 加第三种协议只需要在 PROTOCOLS 里补两个函数，调用方一行不改
 * 3. 各家网关的路径差异集中在这一处，不会散到 UI 里
 *
 * 注意：OpenAI 兼容的「兼容」是有水分的，不同厂商的 baseUrl 有的带 /v1、
 * 有的带 /api/paas/v4，所以 endpointFor 必须按「末尾是否已是版本段」判断，
 * 不能无脑拼 /v1/chat/completions。
 */

export type LlmProtocol = 'openai' | 'anthropic'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface RequestOptions {
  temperature?: number
  maxTokens?: number
}

/**
 * 参数兼容补丁。
 *
 * 推理模型（OpenAI o 系 / gpt-5 一类）把接口收紧了：
 * - `max_tokens` 改名为 `max_completion_tokens`，旧字段直接 400
 * - `temperature` 只接受默认值，传了也 400
 *
 * 这些差异不该让用户去记，所以做成运行时可探测的补丁：
 * 撞到 400 就按报错内容改一次参数名/去掉参数，然后重试同一个请求。
 */
export interface BodyCompat {
  tokenField?: 'max_tokens' | 'max_completion_tokens'
  omitTemperature?: boolean
  /**
   * 推理模型的思考强度。
   *
   * 实测（deepseek-flash，cet6 生成 5 次）：`low` 的合格率 5/5，默认档 2/5 因 JSON 被思考挤断而失败，
   * 关掉思考（thinking.disabled）虽然快 8 倍，但一半的生成会塌成一百多词的残篇。
   * 所以生成文章时优先用 low；服务端不认这个字段（400 提到 reasoning_effort）会自动去掉。
   */
  reasoningEffort?: 'low' | 'medium' | 'high'
}

/** 一个协议要提供的最小能力 */
export interface ProtocolCodec {
  /** 完整请求地址 */
  endpoint: (baseUrl: string) => string
  /** 请求头（含鉴权） */
  headers: (apiKey: string) => Record<string, string>
  /** 请求体；compat 用于适配推理模型的参数差异（目前只有 OpenAI 系需要） */
  body: (
    model: string,
    messages: ChatMessage[],
    opts: RequestOptions,
    compat?: BodyCompat,
  ) => unknown
  /** 从响应里取正文 */
  parse: (payload: unknown) => ParsedReply
}

export interface ParsedReply {
  text: string
  /** 正常结束 / 被长度截断 / 其他 */
  truncated: boolean
  finishReason?: string
  /**
   * 推理模型的思考过程（OpenAI 系的 reasoning_content / Anthropic 的 thinking 块）。
   * 正文为空时用它来判断「是模型没说话，还是预算全花在思考上了」。
   */
  reasoning?: string
}

const VERSION_TAIL = /\/v\d+[a-z0-9.]*$/i

export function normalizeBaseUrl(baseUrl: string): string {
  const t = baseUrl.trim().replace(/\/+$/, '')
  if (!t) throw new Error('Base URL 不能为空')
  if (!/^https?:\/\//i.test(t)) throw new Error('Base URL 必须以 http:// 或 https:// 开头')
  return t
}

/* ---------------------------- OpenAI 兼容 ---------------------------- */

const openai: ProtocolCodec = {
  endpoint(baseUrl) {
    const base = normalizeBaseUrl(baseUrl)
    if (/\/chat\/completions$/i.test(base)) return base
    return VERSION_TAIL.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  },

  headers(apiKey) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }
  },

  body(model, messages, opts, compat = {}) {
    const body: Record<string, unknown> = {
      model,
      messages,
      [compat.tokenField ?? 'max_tokens']: opts.maxTokens ?? 2000,
      stream: false,
    }
    if (!compat.omitTemperature) body.temperature = opts.temperature ?? 0.8
    if (compat.reasoningEffort) body.reasoning_effort = compat.reasoningEffort
    return body
  },

  parse(payload) {
    const data = payload as {
      choices?: {
        message?: { content?: unknown; reasoning_content?: string }
        finish_reason?: string
      }[]
    }
    const choice = data?.choices?.[0]
    const raw = choice?.message?.content
    const reasoning = choice?.message?.reasoning_content
    // 有些网关会返回 [{type:'text',text}] 这种分段结构
    const text =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw
              .map((p) => (typeof p === 'string' ? p : String((p as { text?: string })?.text ?? '')))
              .join('')
          : ''

    return {
      text,
      truncated: choice?.finish_reason === 'length',
      finishReason: choice?.finish_reason,
      reasoning: typeof reasoning === 'string' && reasoning.trim() ? reasoning : undefined,
    }
  },
}

/* ----------------------------- Anthropic ----------------------------- */

const ANTHROPIC_VERSION = '2023-06-01'

const anthropic: ProtocolCodec = {
  endpoint(baseUrl) {
    const base = normalizeBaseUrl(baseUrl)
    if (/\/messages$/i.test(base)) return base
    return VERSION_TAIL.test(base) ? `${base}/messages` : `${base}/v1/messages`
  },

  headers(apiKey) {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    }
  },

  body(model, messages, opts) {
    // Anthropic 没有 system role：系统提示是顶层字段，且只能有一段
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')

    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }))

    return {
      model,
      // 这个字段必填，缺了直接 400
      max_tokens: opts.maxTokens ?? 2000,
      temperature: opts.temperature ?? 0.8,
      ...(system ? { system } : {}),
      messages: turns,
      stream: false,
    }
  },

  parse(payload) {
    const data = payload as {
      content?: { type?: string; text?: string; thinking?: string }[]
      stop_reason?: string
    }
    const blocks = data?.content ?? []
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    const reasoning = blocks
      .filter((b) => b.type === 'thinking')
      .map((b) => b.thinking ?? '')
      .join('')

    return {
      text,
      truncated: data?.stop_reason === 'max_tokens',
      finishReason: data?.stop_reason,
      reasoning: reasoning.trim() ? reasoning : undefined,
    }
  },
}

export const PROTOCOLS: Record<LlmProtocol, ProtocolCodec> = { openai, anthropic }

export const PROTOCOL_LABEL: Record<LlmProtocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
}

/* ------------------------- 错误信息与人话解释 ------------------------- */

/** 从响应体里捞错误文案，两家的结构不一样 */
export function extractErrorMessage(payload: unknown): string | null {
  const p = payload as {
    error?: { message?: string; type?: string } | string
    message?: string
  }
  if (!p) return null
  if (typeof p.error === 'string') return p.error
  if (typeof p.error?.message === 'string') return p.error.message
  if (typeof p.message === 'string') return p.message
  return null
}

export function describeStatus(status: number): string | null {
  if (status === 401) return 'API Key 无效或已过期'
  if (status === 402) return '账户余额不足'
  if (status === 403) return '没有权限调用这个模型'
  if (status === 404) return '接口地址或模型名不对（检查 Base URL 和模型名）'
  if (status === 413) return '请求太长，超出模型上下文'
  if (status === 429) return '请求太频繁或额度用尽，稍后再试'
  if (status === 529) return '模型服务过载，稍后再试'
  if (status >= 500) return '模型服务暂时不可用'
  return null
}
