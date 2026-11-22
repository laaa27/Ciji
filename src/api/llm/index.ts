import { Capacitor, CapacitorHttp } from '@capacitor/core'

import {
  describeStatus,
  extractErrorMessage,
  PROTOCOLS,
  type BodyCompat,
  type ChatMessage,
  type LlmUsage,
  type ParsedReply,
  type RequestOptions,
} from '@/api/protocols'
import { useLlm, type LlmProfile } from '@/store/llm'
import { sleep } from '@/lib/async'

import { nextBudget, isStarved, resolveBudget } from './budget'
import { adaptCompat, describeEmpty, looksLikeBudgetCap } from './negotiate'

/**
 * 大模型调用。协议差异全部交给 api/protocols.ts，这里只负责三件事：
 * 取配置、选通道（原生 / 开发代理）、把失败翻译成人话。
 *
 * 0.24.29 起，原本堆在 `chatCompletion` 一个循环里的两件事拆了出去：
 * - 400 协商与「空正文」的解释 → `./negotiate.ts`（纯函数）
 * - 输出预算的加码与沿用 → `./budget.ts`（纯算术）
 * 这里只剩「发一次请求 + 按结果决定重发哪种」。
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

/**
 * 最近一次**失败**响应的原文，给阅读页的「查看模型原始响应」用。
 *
 * 只在抛错前写入：并行 4 路成文时成功响应会互相覆盖，而这个值只有错误面板会读，
 * 记成功的那次既没用、又会把真正的失败原文冲掉。
 */
let lastRaw: string | null = null

export function getLastLlmResponse(): string | null {
  return lastRaw
}

/**
 * 一次逻辑调用的用量。`requests` 是实际发出的 HTTP 请求数——
 * 它比"一次调用"大，只可能是参数协商（400）、瞬时失败重试或截断加码，
 * 也就是说这条路悄悄多付了一整轮钱。这个数字比耗时更能说明重试有没有在乱花钱。
 */
export interface CallUsage extends LlmUsage {
  requests: number
}

/**
 * 一次调用的返回值：正文 + 这一次自己的用量。
 *
 * 为什么用量必须跟着返回值走，而不是留在模块级单例里：
 * 生成改成「并行 N 路」之后，同一时刻会有多条调用在飞，`读走即清` 的槽位会被互相覆盖
 * （A 读完清空，B 写进去，A 再取就拿到了 B 的数）。串账的后果是 `Article.usage` 变成脏数据，
 * 而且这种错误不会报错，只会让「花了多少钱」永久不可信。
 */
export interface ChatResult {
  text: string
  /** 拿不到 usage 的网关会返回 null */
  usage: CallUsage | null
}

/**
 * 开发期用的转发入口（见 vite.config.ts 的 llmProxy 插件）
 */
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

/**
 * 按 profile 记住「协商过的参数」与「够用的输出预算」，只放内存。
 * 意义是不让每次生成都先撞一次 400、再因为预算不够白跑一轮。
 */
const compatCache = new Map<string, BodyCompat>()
const budgetFloor = new Map<string, number>()

/**
 * 400 的两种自救，返回 null 表示「这条 400 救不了」。
 *
 * - 预算撞上模型硬顶：退回原始值（`budget-fallback`），别把用户的词表卡死
 * - 参数不被接受：按报错改一个字段（`compat`），下次重发
 *
 * 抽成独立函数是因为这里混了三种判断（能不能回退、能不能协商、协商到第几次），
 * 留在循环里读起来像四个开关同时拨。
 */
type Rescue =
  | { kind: 'budget-fallback' }
  | { kind: 'compat'; next: Partial<BodyCompat> }

function rescue400(
  detail: string,
  compat: BodyCompat,
  compatFix: number,
  canFallBack: boolean,
): Rescue | null {
  if (compatFix >= 2) return null
  if (canFallBack && looksLikeBudgetCap(detail)) return { kind: 'budget-fallback' }
  const next = adaptCompat(detail, compat)
  return next ? { kind: 'compat', next } : null
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
): Promise<ChatResult> {
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
  let maxTokens = resolveBudget(baseTokens, budgetFloor.get(target.id))

  let transient = 0
  let compatFix = 0
  let budgetFellBack = false
  /** 因为「额度被用尽」加码重试过几次（空正文与截断共用这个计数） */
  let budgetEscalations = 0
  let lastError: LlmError | null = null

  /** 额度还够翻倍就加码；已经到顶返回 false，交给上层如实报错 */
  const escalateBudget = (reply: ParsedReply): boolean => {
    if (!isStarved(reply)) return false
    const next = nextBudget(maxTokens, budgetEscalations)
    if (next === null) return false
    budgetEscalations += 1
    maxTokens = next
    return true
  }

  /** 抛错前记下这次响应的原文（见 lastRaw 的注释） */
  const fail = (err: LlmError, raw: string): never => {
    lastRaw = raw
    throw err
  }

  for (let guard = 0; guard < 8; guard += 1) {
    const res = await post(target, messages, { ...opts, maxTokens }, compat)

    if (res.status < 200 || res.status >= 300) {
      const detail = extractErrorMessage(res.payload) ?? ''
      const brief = describeStatus(res.status)

      // 只有 400 才谈得上「参数不被接受」；401/404 的报错文本里也可能出现这些词
      const rescue =
        res.status === 400
          ? rescue400(detail, compat, compatFix, Boolean(maxTokens) && !budgetFellBack)
          : null
      if (rescue?.kind === 'budget-fallback') {
        maxTokens = baseTokens
        budgetFellBack = true
        continue
      }
      if (rescue?.kind === 'compat') {
        compat = { ...compat, ...rescue.next }
        compatCache.set(target.id, compat)
        compatFix += 1
        continue
      }

      lastError = new LlmError([brief, detail.slice(0, 140)].filter(Boolean).join('：'), res.status)

      // 限流与服务端错误重试一次；鉴权、地址这类重试没意义
      if ((res.status === 429 || res.status >= 500) && transient < MAX_TRANSIENT) {
        transient += 1
        await sleep(RETRY_DELAY_MS)
        continue
      }
      return fail(lastError, res.raw)
    }

    const reply = codec.parse(res.payload)

    if (!reply.text.trim()) {
      lastError = new LlmError(describeEmpty(reply, res.payload), res.status)

      // 额度被思维链吃光时先加码（max_tokens 只是上限，没用到不额外收费）；
      // 加码到顶才走「瞬时失败」那次重试，最后才报错
      if (escalateBudget(reply)) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      if (transient < MAX_TRANSIENT) {
        transient += 1
        await sleep(RETRY_DELAY_MS)
        continue
      }
      return fail(lastError, res.raw)
    }

    if (reply.truncated) {
      // 截断说明额度被正文（推理模型还包括思考）吃光了。原先这里直接抛错，
      // 上层重试用的是同一个预算，于是同样的截断必然再发生一次——
      // 考研档开思考时实测 3/3 全部失败。这里逐级加码，到顶才报错。
      if (escalateBudget(reply)) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      return fail(
        new LlmError('输出被长度上限截断了，换短一点的词表或换支持更长输出的模型'),
        res.raw,
      )
    }

    // 这次是靠加大预算才成的，记住它，下一轮直接用
    if (maxTokens && maxTokens > (baseTokens ?? 0)) {
      budgetFloor.set(target.id, maxTokens)
    }

    return {
      text: reply.text,
      // guard + 1 = 到这一步为止已经发出去的请求数（重试与协商都算在内）
      usage: reply.usage ? { ...reply.usage, requests: guard + 1 } : null,
    }
  }

  throw lastError ?? new LlmError('生成失败，请重试')
}

/** 设置页「测试连接」：发一句最短的请求；可传草稿配置，保存前先验证 */
export async function testConnection(profile?: LlmProfile): Promise<string> {
  const { text } = await chatCompletion(
    [{ role: 'user', content: '只回复两个字：正常' }],
    { maxTokens: 32, temperature: 0, timeoutMs: 30000 },
    profile,
  )
  return text.trim().slice(0, 20)
}
