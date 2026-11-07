import { Capacitor, CapacitorHttp } from '@capacitor/core'

/**
 * 统一请求封装。
 *
 * 为什么要分两条路：
 * - 墨墨 API 没有返回 CORS 头，浏览器里直接 fetch 会被拦。
 * - 开发时（浏览器）：走 Vite 代理，路径前缀 /open。
 * - 真机（WebView）：用 Capacitor 的原生 HTTP，完全绕过 CORS。
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

let tokenProvider: () => string | null = () => null

/** 由 session store 注入，避免 api 层直接依赖 store */
export function setTokenProvider(fn: () => string | null) {
  tokenProvider = fn
}

function friendlyMessage(status: number, raw: string): string {
  if (status === 401 || status === 403) return '凭证无效或已失效，请到设置页重新填写'
  if (status === 429) return '请求太频繁，等几秒再试'
  if (status >= 500) return '墨墨服务暂时不可用，稍后再试'
  const detail = raw.trim().slice(0, 120)
  return detail ? `请求失败：${detail}` : `请求失败（${status}）`
}

function timeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), ms)
  return ctrl.signal
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const token = tokenProvider()
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

    if (res.status < 200 || res.status >= 300) {
      const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
      throw new ApiError(friendlyMessage(res.status, raw), res.status)
    }

    // 原生层可能已解析成对象，也可能是字符串
    return (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as T
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

  if (!res.ok) {
    throw new ApiError(friendlyMessage(res.status, text), res.status)
  }

  return JSON.parse(text) as T
}
