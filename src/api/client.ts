import { Capacitor, CapacitorHttp } from '@capacitor/core'

/**
 * 统一请求封装。
 *
 * 两个必须知道的点：
 * 1. 墨墨 API 没有返回 CORS 头 → 浏览器直连会被拦。
 *    开发时走 Vite 代理（/open），真机用 Capacitor 原生 HTTP 绕过。
 * 2. 响应外面包了一层信封：{ success, data, errors }
 *    真正的数据在 data 里。这份格式来自官方 CLI 的解析逻辑
 *    (maimemo/memo-api-cli src/client.ts)，比 api_bundle.yaml 的 schema 更接近实际。
 */

const NATIVE_BASE = 'https://open.maimemo.com/open'
const WEB_BASE = '/open'

export class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type ApiEnvelope<T> = {
  success?: boolean
  data?: T
  errors?: { code?: string; msg?: string; message?: string; info?: string }[]
}

let tokenProvider: () => string | null = () => null

/** 最近一次请求的原始响应，用于设置页诊断 */
let lastRawResponse: string | null = null

export function getLastRawResponse(): string | null {
  return lastRawResponse
}

/** 由 session store 注入，避免 api 层直接依赖 store */
export function setTokenProvider(fn: () => string | null) {
  tokenProvider = fn
}

const ERROR_HINT: Record<string, string> = {
  common_unauthorized: '凭证无效或已失效，请重新填写',
  common_forbidden: '这个账号没有该接口权限',
  common_too_many_requests: '请求太频繁，等几秒再试',
}

function describeError(raw: string, status: number): string {
  try {
    const json = JSON.parse(raw) as ApiEnvelope<unknown>
    const first = json.errors?.[0]
    if (first) {
      const hint = first.code ? ERROR_HINT[first.code] : undefined
      if (hint) return hint
      const msg = first.msg || first.message
      if (msg) return first.code ? `${msg}（${first.code}）` : msg
    }
  } catch {
    // 不是 JSON，走下面的通用文案
  }

  if (status === 401 || status === 403) return '凭证无效或已失效，请到设置页重新填写'
  if (status === 429) return '请求太频繁，等几秒再试'
  if (status >= 500) return '墨墨服务暂时不可用，稍后再试'
  return `请求失败（${status}）`
}

/** 剥掉响应信封，取出真正的数据；同时把业务错误变成异常 */
function unwrap<T>(raw: string): T {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new ApiError(`返回内容不是合法 JSON：${raw.slice(0, 120)}`)
  }

  const env = json as ApiEnvelope<T>

  if (Array.isArray(env.errors) && env.errors.length > 0) {
    throw new ApiError(describeError(raw, 200))
  }
  if (env.success === false) {
    throw new ApiError(describeError(raw, 200))
  }

  // 有 data 就用 data，没有就认为整包就是数据（兼容旧格式）
  return (env.data ?? (json as T)) as T
}

function timeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), ms)
  return ctrl.signal
}

export async function post<T>(
  path: string,
  body: unknown,
  overrideToken?: string,
): Promise<T> {
  const token = overrideToken ?? tokenProvider()
  if (!token) throw new ApiError('还没有填写接口凭证')

  const native = Capacitor.isNativePlatform()

  if (native) {
    const res = await CapacitorHttp.post({
      url: NATIVE_BASE + path,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      data: body ?? {},
      connectTimeout: 15000,
      readTimeout: 25000,
    })

    const raw =
      typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null)
    lastRawResponse = raw

    if (res.status < 200 || res.status >= 300) {
      throw new ApiError(describeError(raw, res.status), res.status)
    }

    return unwrap<T>(raw)
  }

  const res = await fetch(WEB_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
    signal: timeoutSignal(25000),
  })

  const text = await res.text()
  lastRawResponse = text

  if (!res.ok) {
    throw new ApiError(describeError(text, res.status), res.status)
  }

  return unwrap<T>(text)
}
