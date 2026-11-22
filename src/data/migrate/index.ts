import { Preferences } from '@capacitor/preferences'

import { readJson, writeJson } from '@/data/files'
import { writeDumpVerified } from './dump'

/**
 * 一次性迁移的公共零件（0.24.29 起）。
 *
 * 背景：0.24.22–0.24.28 把文章、每日记录、释义缓存陆续从 Preferences 搬进文件，
 * 每次都要写一遍同一套五步——标记键、扫旧前缀、先落原件、读回校验、才删旧键。
 * 到第三、第四遍时细节已经开始分叉，而这段代码一旦写错就是**用户数据丢失**，
 * 所以把「标记」「扫描」「删除」「写原件并校验」「每会话一次」收在这里。
 *
 * 不动的东西：各族的业务差异（每日记录分批 120 天、释义分主/备两族、文章索引可再生
 * 所以不留副本）仍留在各自模块里，这里只提供零件，不预设流程。
 */

/** 迁移完成标记。全部搬完才写；有残留就不写，下次启动整体重试 */
export async function isMigrated(key: string): Promise<boolean> {
  const { value } = await Preferences.get({ key })
  return value === '1'
}

export async function markMigrated(key: string): Promise<void> {
  await Preferences.set({ key, value: '1' }).catch(() => {})
}

/** 按前缀扫出旧键（原始键名，不剥前缀——各族剥法不同） */
export async function legacyKeys(prefixes: string[]): Promise<string[]> {
  const { keys } = await Preferences.keys()
  return keys.filter((k) => prefixes.some((p) => k.startsWith(p)))
}

/**
 * 删一批旧键。
 *
 * 默认吞掉单个键的失败：删不掉只是让它继续占着慢存储，下个会话还会再搬一次，
 * 不影响正确性。需要知道「有没有残留」的调用方传 `onError`（文章正文迁移据此决定
 * 打不打完成标记）。
 */
export async function removeLegacyKeys(keys: string[], onError?: () => void): Promise<void> {
  for (const key of keys) {
    try {
      await Preferences.remove({ key })
    } catch {
      onError?.()
    }
  }
}

/**
 * 写一份「原件副本」并读回校验。校验不过抛错，调用方应当中断迁移、保留旧键。
 * 副本本身也是给用户留的底：搬坏了还能从这里捞回来。
 */
export async function writeVerifiedDump<T>(
  path: string,
  payload: T,
  same: (back: T | null) => boolean,
  message: string,
): Promise<void> {
  await writeDumpVerified(
    { write: (p, v) => writeJson(p, v), read: (p) => readJson<T>(p) },
    path,
    payload,
    same,
    message,
  )
}

/**
 * 把一次性任务包成「每会话最多跑一次」。
 *
 * 失败时清掉「已尝试」，让同会话后续调用或下次启动还能重试——
 * 迁移不允许因为一次失败就在本次会话里彻底放弃。
 */
export function createOnceTask(run: () => Promise<void>): () => Promise<void> {
  let attempted = false
  return async () => {
    if (attempted) return
    attempted = true
    try {
      await run()
    } catch {
      attempted = false
    }
  }
}
