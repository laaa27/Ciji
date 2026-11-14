/**
 * 请求构造与响应解析（只保留 OpenAI 兼容一种格式）。
 *
 * 2026-11-14 精简：Anthropic 的原生格式已移除。产品只面向 OpenAI 兼容网关
 * （DeepSeek / 智谱 / one-api / LM Studio / Ollama 都走这套），
 * 留着第二种格式的代价是每个调用点都要考虑两种 system 语义与两套用量字段。
 *
 * 单独抽成纯函数模块的好处：不依赖 Capacitor，可以在 node 里直接跑断言；
 * 各家网关的路径差异集中在这一处，不会散到 UI 里
 *
 * 注意：OpenAI 兼容的「兼容」是有水分的，不同厂商的 baseUrl 有的带 /v1、
 * 有的带 /api/paas/v4，所以 endpointFor 必须按「末尾是否已是版本段」判断，
 * 不能无脑拼 /v1/chat/completions。
 */

export type LlmProtocol = 'openai'

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
  /**
   * 明确关闭思考（DeepSeek 系接受 `thinking: {type:'disabled'}`，实测思考 0 字、秒级返回）。
   *
   * 为什么不是「不传参数」：推理模型不传 reasoning_effort 时会走默认思考档，
   * 又慢又贵（deepseek-flash 默认档 62 秒/次，还会把 JSON 挤截断）。
   * 「关闭」必须显式声明才有意义；普通模型不认这个字段时会在 400 里说明，自动去掉并记住。
   * 与 reasoningEffort 互斥，同时给时 thinking 优先。
   */
  thinkingDisabled?: boolean
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

/**
 * 一次调用的 token 用量。
 *
 * 三家的字段名各不相同（OpenAI 的 prompt_tokens / Anthropic 的 input_tokens /
 * DeepSeek 另加 prompt_cache_hit_tokens），统一成这三个数后上层才不用分协议判断。
 *
 * `cached` 是**输入里走了提示词缓存的那部分**，它只可能来自前缀完全一致的重发。
 * 它不是给用户看的性能指标，而是验证「提示词里静态部分有没有排在动态内容前面」的唯一证据：
 * 换成另一批词表再请求，命中量应该基本不变；如果归零，说明变量又跑到前缀里去了。
 */
export interface LlmUsage {
  /** 输入 token（含命中缓存的部分） */
  prompt: number
  /** 输出 token；推理模型的思考也计在这里 */
  completion: number
  /** 输入中命中提示词缓存的前缀 token；服务端不报就是 0 */
  cached: number
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
  /** 服务端没报用量（部分网关会省略 usage 字段）时为空 */
  usage?: LlmUsage
}

/** 宽松取数：用量字段可能缺失、可能是字符串，缺就当 0，不让统计把解析搞崩 */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
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
    if (compat.thinkingDisabled) body.thinking = { type: 'disabled' }
    else if (compat.reasoningEffort) body.reasoning_effort = compat.reasoningEffort
    return body
  },

  parse(payload) {
    const data = payload as {
      choices?: {
        message?: { content?: unknown; reasoning_content?: string }
        finish_reason?: string
      }[]
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        /** OpenAI 官方字段 */
        prompt_tokens_details?: { cached_tokens?: number }
        /** DeepSeek 字段：命中缓存的前缀 token */
        prompt_cache_hit_tokens?: number
      }
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

    const u = data?.usage

    return {
      text,
      truncated: choice?.finish_reason === 'length',
      finishReason: choice?.finish_reason,
      reasoning: typeof reasoning === 'string' && reasoning.trim() ? reasoning : undefined,
      usage: u
        ? {
            prompt: num(u.prompt_tokens),
            completion: num(u.completion_tokens),
            cached: num(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens),
          }
        : undefined,
    }
  },
}

export const PROTOCOLS: Record<LlmProtocol, ProtocolCodec> = { openai }

export const PROTOCOL_LABEL: Record<LlmProtocol, string> = {
  openai: 'OpenAI 兼容',
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
