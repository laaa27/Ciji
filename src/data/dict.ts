/**
 * 离线词典查询。
 *
 * 词库是按首字母分片的 JSON（构建产物在 public/dict/），
 * 只有真正要显示词表时才按需加载对应分片，首屏不受影响。
 */

const cache = new Map<string, Record<string, string>>()
const inflight = new Map<string, Promise<Record<string, string>>>()

function shardKey(word: string): string {
  const first = word.trim().charAt(0).toLowerCase()
  return first >= 'a' && first <= 'z' ? first : 'other'
}

async function loadShard(key: string): Promise<Record<string, string>> {
  const hit = cache.get(key)
  if (hit) return hit

  const pending = inflight.get(key)
  if (pending) return pending

  const task = (async () => {
    try {
      const res = await fetch(`dict/${key}.json`)
      if (!res.ok) return {}
      const data = (await res.json()) as Record<string, string>
      cache.set(key, data)
      return data
    } catch {
      return {}
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}

/** 批量查询释义，返回 拼写 → 释义 的映射；查不到的不出现在结果里 */
export async function lookupWords(
  spellings: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (spellings.length === 0) return result

  const wanted = new Set(spellings.map((s) => s.trim().toLowerCase()))
  const keys = new Set<string>()
  for (const s of wanted) keys.add(shardKey(s))

  await Promise.all(
    [...keys].map(async (key) => {
      const shard = await loadShard(key)
      for (const [word, gloss] of Object.entries(shard)) {
        if (wanted.has(word)) result.set(word, gloss)
      }
    }),
  )

  return result
}

export function hasShardLoaded(key: string): boolean {
  return cache.has(key)
}
