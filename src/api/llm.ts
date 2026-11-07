import { Capacitor, CapacitorHttp } from '@capacitor/core'

import { activeModel, PROVIDERS, useLlm } from '@/store/llm'

/**
 * 大模型调用（OpenAI 兼容的 /chat/completions）。
 *
 * 和墨墨接口同样的双路策略：
 * - 真机走 CapacitorHttp，不受 CORS 限制
 * - 浏览器开发走 Vite 代理（/llm/<provider>/...）
 */

export class LlmError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.status = status
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

let lastRaw: string | null = null

export function getLastLlmResponse(): string | null {
  return lastRaw
}

function endpoint(provider: keyof typeof PROVIDERS, native: boolean): string {
  const meta = PROVIDERS[provider]
  if (native) return `${meta.baseUrl}/chat/completions`
  return `/llm/${provider}/chat/completions`
}

function describe(status: number, raw: string): string {
  if (status === 401 || status === 403) return 'API Key 无效，请到设置里重新填写'
  if (status === 429) return '请求太频繁或额度用尽，稍后再试'
  if (status === 402) return '账户余额不足'
  if (status >= 500) return '模型服务暂时不可用'

  try {
    const json = JSON.parse(raw) as {
      error?: { message?: string; code?: string }
      message?: string
    }
    const msg = json.error?.message || json.message
    if (msg) return msg.slice(0, 160)
  } catch {
    // 非 JSON
  }
  return `请求失败（${status}）`
}

/** 发起一次对话，返回纯文本内容 */
export async function chatCompletion(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { provider, apiKey, model } = useLlm.getState()
  if (!apiKey) throw new LlmError('还没有配置大模型 API Key')

  const body = {
    model: activeModel({ provider, model }),
    messages,
    temperature: opts.temperature ?? 0.8,
    max_tokens: opts.maxTokens ?? 2000,
    stream: false,
  }

  const native = Capacitor.isNativePlatform()
  const url = endpoint(provider, native)

  if (native) {
    const res = await CapacitorHttp.post({
      url,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      data: body,
      connectTimeout: 15000,
      readTimeout: opts.timeoutMs ?? 90000,
    })

    const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null)
    lastRaw = raw

    if (res.status < 200 || res.status >= 300) {
      throw new LlmError(describe(res.status, raw), res.status)
    }

    const content = extractContent(typeof res.data === 'string' ? JSON.parse(raw) : res.data)
    if (content === null) throw new LlmError('模型返回了空内容，请重试')
    return content
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90000)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })

    const text = await res.text()
    lastRaw = text

    if (!res.ok) throw new LlmError(describe(res.status, text), res.status)

    const content = extractContent(JSON.parse(text) as unknown)
    if (content === null) throw new LlmError('模型返回了空内容，请重试')
    return content
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new LlmError('生成超时了，换个短一点的词表再试')
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function extractContent(payload: unknown): string | null {
  const data = payload as {
    choices?: { message?: { content?: string } }[]
    error?: { message?: string }
  }
  if (data?.error?.message) throw new LlmError(data.error.message.slice(0, 160))
  const content = data?.choices?.[0]?.message?.content
  return typeof content === 'string' && content.trim() ? content : null
}

/** 设置页「测试连接」：发一句最短的请求 */
export async function testConnection(): Promise<string> {
  const reply = await chatCompletion(
    [{ role: 'user', content: '只回复两个字：正常' }],
    { maxTokens: 20, temperature: 0, timeoutMs: 30000 },
  )
  return reply.trim().slice(0, 20)
}
