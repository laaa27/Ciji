import { lemmaCandidates } from '@/lib/lemma'

/**
 * 本地词典：ECDICT 分片，按首字母懒加载。
 *
 * 只回答"这个拼写或它的变形在本地词库里有没有"，不关心释义从哪来、要不要联网——
 * 查词链的编排在 `domain/lookup.ts`，释义缓存（含备选释义）在 `data/gloss.ts`。
 */

const SHARD_CACHE = new Map<string, Record<string, string>>()
const SHARD_INFLIGHT = new Map<string, Promise<Record<string, string>>>()

/** 加载失败时用的空表。同一个分片 404 一次就记住，别每次查都重发一个注定失败的请求 */
const EMPTY_SHARD: Record<string, string> = {}

function shardKey(word: string): string {
  const first = word.trim().charAt(0).toLowerCase()
  return first >= 'a' && first <= 'z' ? first : 'other'
}

async function loadShard(key: string): Promise<Record<string, string>> {
  const hit = SHARD_CACHE.get(key)
  if (hit) return hit

  const pending = SHARD_INFLIGHT.get(key)
  if (pending) return pending

  const task = (async () => {
    try {
      const res = await fetch(`dict/${key}.json`)
      // 404 是稳定事实（没有 other.json 这个分片），记下来免得每次查都重发；
      // 网络抖动属于临时故障，不缓存，下次还能重试
      if (!res.ok) {
        SHARD_CACHE.set(key, EMPTY_SHARD)
        return EMPTY_SHARD
      }
      const data = (await res.json()) as Record<string, string>
      SHARD_CACHE.set(key, data)
      return data
    } catch {
      return EMPTY_SHARD
    } finally {
      SHARD_INFLIGHT.delete(key)
    }
  })()

  SHARD_INFLIGHT.set(key, task)
  return task
}

/**
 * 本地词典里有没有这个词（查变形候选时用来去噪）。
 * 纯本地分片查询，不走网络。
 */
export async function dictHas(word: string): Promise<boolean> {
  const key = word.trim().toLowerCase()
  if (!key) return false
  const shard = await loadShard(shardKey(key))
  return Boolean(shard[key])
}

/**
 * 把一批词涉及的分片并行预热。
 *
 * 分片是懒加载的，逐个查会让每个字母的 fetch 串起来排队（26 个字母最坏 26 次串行 IO）；
 * 先并行拉一遍，后面查表就只剩内存操作。
 */
export async function warmShards(words: string[]): Promise<void> {
  const keys = new Set<string>()
  for (const w of words) for (const cand of lemmaCandidates(w)) keys.add(shardKey(cand))
  await Promise.all([...keys].map((k) => loadShard(k)))
}

/** 同步查表版：调用前必须先 `warmShards`，否则会漏掉还没加载的分片 */
export function lookupLocalSync(word: string): string | null {
  for (const cand of lemmaCandidates(word)) {
    const hit = SHARD_CACHE.get(shardKey(cand))?.[cand]
    if (hit) return hit
  }
  return null
}

/** 单个词查本地词典（点词用）。分片按候选顺序加载，通常同一片 */
export async function lookupLocal(word: string): Promise<string | null> {
  for (const cand of lemmaCandidates(word)) {
    const shard = await loadShard(shardKey(cand))
    const hit = shard[cand]
    if (hit) return hit
  }
  return null
}

/** 简单并发控制，避免一次性打爆免费接口 */
