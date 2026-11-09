import { Preferences } from '@capacitor/preferences'

/**
 * 检查更新：更新渠道是 GitHub Releases（laaa27/Ciji）。
 *
 * 每次打开 App 自动查一次（设置里可关），只有发布了比本地更新的 release 才提示，
 * 提示里带上 release 的更新日志。查不到（断网/限流/接口改版）一律静默跳过——
 * 更新检查是锦上添花，绝不能在启动路径上报错打扰。
 */

const REPO = 'laaa27/Ciji'
const K_AUTO = 'update_auto_check'

export interface ReleaseInfo {
  /** 规范化后的版本号（去掉 v 前缀），如 0.22.0 */
  version: string
  /** release 标题 */
  name: string
  /** release 更新日志原文（markdown 纯文本展示） */
  notes: string
  /** GitHub 发布页地址 */
  url: string
}

export async function isAutoCheckEnabled(): Promise<boolean> {
  const { value } = await Preferences.get({ key: K_AUTO })
  return value !== 'false'
}

export async function setAutoCheckEnabled(enabled: boolean): Promise<void> {
  await Preferences.set({ key: K_AUTO, value: enabled ? 'true' : 'false' })
}

/** "v0.22.0" → "0.22.0" */
function normalizeVersion(tag: string): string {
  return tag.trim().replace(/^v/i, '')
}

/** 逐段比较点分版本号；段数不齐按 0 补。0.21.0 < 0.22.0 < 1.0 */
export function isNewerVersion(remote: string, local: string): boolean {
  const a = normalizeVersion(remote).split('.').map((n) => Number.parseInt(n, 10) || 0)
  const b = normalizeVersion(local).split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * 拉取最新 release。8 秒超时；失败返回 null（调用方静默跳过）。
 * GitHub API 支持 CORS 且允许匿名访问（限流 60 次/小时/IP，一次启动一次查绰绰有余）。
 */
export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null

    const data = (await res.json()) as {
      tag_name?: string
      name?: string
      body?: string
      html_url?: string
      draft?: boolean
      prerelease?: boolean
    }
    if (!data?.tag_name || data.draft || data.prerelease) return null

    return {
      version: normalizeVersion(data.tag_name),
      name: data.name?.trim() || normalizeVersion(data.tag_name),
      notes: data.body?.trim() ?? '',
      url: data.html_url ?? `https://github.com/${REPO}/releases`,
    }
  } catch {
    return null
  }
}

/** 自动检查的完整入口：开了开关 → 拉最新 release → 确实比本地新才返回 */
export async function checkForUpdate(): Promise<ReleaseInfo | null> {
  if (!(await isAutoCheckEnabled())) return null
  const release = await fetchLatestRelease()
  if (!release) return null
  return isNewerVersion(release.version, __APP_VERSION__) ? release : null
}
