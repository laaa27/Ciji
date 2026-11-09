import { Capacitor, CapacitorHttp } from '@capacitor/core'

/**
 * 统一请求封装。
 *
 * 三个必须知道的点：
 * 1. 墨墨 API 没有返回 CORS 头 → 浏览器直连会被拦。
 *    开发时走 Vite 代理（/open），真机用 Capacitor 原生 HTTP 绕过。
 * 2. 响应外面包了一层信封：{ success, data, errors }
 *    真正的数据在 data 里。这份格式来自官方 CLI 的解析逻辑
 *    (maimemo/memo-api-cli src/client.ts)，比 api_bundle.yaml 的 schema 更接近实际。
 * 3. 公测接口会偶发 500（`common_internal_error`），一次都不重试等于让用户手点。
 *    所以读接口可以带 retries，写完的接口一律不带（非幂等）。
 */

const NATIVE_BASE = 'https://open.maimemo.com/open'
const WEB_BASE = '/open'

/** 一次重试的等待时间。太短等于没等，太长用户会以为卡住了 */
const RETRY_DELAY_MS = 700
/** 撞频控时多等一会儿 —— 10 秒 20 次的闸口不是几百毫秒能过去的 */
const RATE_LIMIT_DELAY_MS = 1500

/**
 * 「重试一次可能就好了」的服务端错误码。
 *
 * `common_internal_error` 正是启动初期偶发的那一条：它可能伴随 HTTP 200 返回，
 * 所以只按状态码判会漏掉，必须看 code。
 */
const TRANSIENT_CODES = new Set([
  'common_internal_error',
  'common_service_unavailable',
  'common_too_many_requests',
])

export class ApiError extends Error {
  readonly status?: number
  readonly code?: string
  /** 传输层失败（断网、DNS、超时），和「服务端回了个错」是两码事 */
  readonly network: boolean
  /** 服务端原始响应（供界面展开看，定位 500 还是 200 带信封） */
  readonly raw?: string

  constructor(message: string, status?: number, code?: string, network = false, raw?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.network = network
    this.raw = raw
  }

  /** 值不值得再试一次 */
  get retryable(): boolean {
    if (this.network) return true
    if (this.code) return TRANSIENT_CODES.has(this.code)
    return typeof this.status === 'number' && this.status >= 500
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
  common_internal_error: '墨墨服务端暂时异常',
  common_service_unavailable: '墨墨服务暂时不可用',
}

/**
 * 把一次失败翻译成带 code 的异常。
 *
 * code 是重试判定的依据，不能只留文案 —— 所以这里返回异常对象而不是字符串。
 */
function errorFrom(raw: string, status: number): ApiError {
  try {
    const json = JSON.parse(raw) as ApiEnvelope<unknown>
    const first = json.errors?.[0]
    if (first) {
      const hint = first.code ? ERROR_HINT[first.code] : undefined
      if (hint) return new ApiError(hint, status, first.code, false, raw)

      const msg = first.msg || first.message
      if (msg) {
        return new ApiError(first.code ? `${msg}（${first.code}）` : msg, status, first.code, false, raw)
      }
    }
  } catch {
    // 不是 JSON，走下面的通用文案
  }

  if (status === 401 || status === 403) {
    return new ApiError('凭证无效或已失效，请到设置页重新填写', status, undefined, false, raw)
  }
  if (status === 429) {
    return new ApiError('请求太频繁，等几秒再试', status, 'common_too_many_requests', false, raw)
  }
  if (status >= 500) return new ApiError('墨墨服务暂时不可用，稍后再试', status, undefined, false, raw)
  return new ApiError(`请求失败（${status}）`, status, undefined, false, raw)
}

/** 剥掉响应信封，取出真正的数据；同时把业务错误变成异常 */
function unwrap<T>(raw: string, status: number): T {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new ApiError(`返回内容不是合法 JSON：${raw.slice(0, 120)}`)
  }

  const env = json as ApiEnvelope<T>

  if (Array.isArray(env.errors) && env.errors.length > 0) {
    throw errorFrom(raw, status)
  }
  if (env.success === false) {
    throw errorFrom(raw, status)
  }

  // 有 data 就用 data，没有就认为整包就是数据（兼容旧格式）
  return (env.data ?? (json as T)) as T
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 只发一次，不重试。重试策略在 post() 里统一处理 */
async function once<T>(path: string, body: unknown, overrideToken?: string): Promise<T> {
  const token = overrideToken ?? tokenProvider()
  if (!token) throw new ApiError('还没有填写接口凭证')

  const native = Capacitor.isNativePlatform()

  if (native) {
    let res: { status: number; data: unknown }
    try {
      res = await CapacitorHttp.post({
        url: NATIVE_BASE + path,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        data: body ?? {},
        connectTimeout: 15000,
        readTimeout: 25000,
      })
    } catch (e) {
      throw new ApiError(
        `网络请求失败：${e instanceof Error ? e.message : '未知原因'}`,
        0,
        undefined,
        true,
      )
    }

    const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null)
    lastRawResponse = raw

    // 原生层在某些传输失败下会给个 status 0，而不是抛异常
    if (!res.status) throw new ApiError('网络请求失败，检查一下网络', 0, undefined, true)

    if (res.status < 200 || res.status >= 300) {
      throw errorFrom(raw, res.status)
    }

    return unwrap<T>(raw, res.status)
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25000)
  try {
    const res = await fetch(WEB_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    })

    const text = await res.text()
    lastRawResponse = text

    if (!res.ok) throw errorFrom(text, res.status)

    return unwrap<T>(text, res.status)
  } catch (e) {
    if (e instanceof ApiError) throw e
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError('请求超时', 0, undefined, true)
    }
    throw new ApiError(
      `网络请求失败：${e instanceof Error ? e.message : '未知原因'}`,
      0,
      undefined,
      true,
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 发一个请求。
 *
 * @param retries 失败后最多再试几次。只给**读接口**传 1 ——
 *   `add_words` / `advance_study` 这类写接口重试会造成重复添加，一律不传。
 */
export async function post<T>(
  path: string,
  body: unknown,
  overrideToken?: string,
  retries = 0,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await once<T>(path, body, overrideToken)
    } catch (e) {
      const err =
        e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : '请求失败')

      if (!err.retryable || attempt >= retries) {
        // 已经替用户试过了就得说出来，否则看着像一次都没试
        if (err.retryable && retries > 0) {
          throw new ApiError(
            `${err.message}（已自动重试一次）`,
            err.status,
            err.code,
            err.network,
            err.raw,
          )
        }
        throw err
      }

      await sleep(err.code === 'common_too_many_requests' ? RATE_LIMIT_DELAY_MS : RETRY_DELAY_MS)
    }
  }
}
