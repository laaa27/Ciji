import { Preferences } from '@capacitor/preferences'

/**
 * 查词：本地词典优先，查不到再走在线翻译。
 *
 * 三层：
 * 1. 本地 ECDICT 分片（按首字母懒加载）—— 快、离线、覆盖单词
 * 2. 词形还原 —— went → go，studies → study，解决变形词
 * 3. 在线兜底（MyMemory，免费无 key）—— 解决短语和生僻词
 *
 * 在线结果会写进 Preferences 永久缓存，同一个词只请求一次。
 * 墨墨自己的 Vocabulary 接口不含释义（只有 id + spelling），所以释义必须外部解决。
 */

const SHARD_CACHE = new Map<string, Record<string, string>>()
const SHARD_INFLIGHT = new Map<string, Promise<Record<string, string>>>()
const GLOSS_MEMORY = new Map<string, string>()

const GLOSS_PREFIX = 'gloss:'
const ONLINE_FLAG = 'online_lookup'

/** 一次查词最多在线补这么多个，避免耗尽免费配额 */
const MAX_ONLINE_PER_CALL = 20
/** 在线请求并发上限 */
const ONLINE_CONCURRENCY = 3

let onlineEnabled = true

export function setOnlineLookup(enabled: boolean) {
  onlineEnabled = enabled
}

export function isOnlineLookupEnabled() {
  return onlineEnabled
}

/** 启动时读取设置 */
export async function loadLookupSettings(): Promise<void> {
  const { value } = await Preferences.get({ key: ONLINE_FLAG })
  onlineEnabled = value !== 'false'
}

export async function saveOnlineLookup(enabled: boolean): Promise<void> {
  onlineEnabled = enabled
  await Preferences.set({ key: ONLINE_FLAG, value: enabled ? 'true' : 'false' })
}

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
      if (!res.ok) return {}
      const data = (await res.json()) as Record<string, string>
      SHARD_CACHE.set(key, data)
      return data
    } catch {
      return {}
    } finally {
      SHARD_INFLIGHT.delete(key)
    }
  })()

  SHARD_INFLIGHT.set(key, task)
  return task
}

/** 不规则复数：只收考试词库里高频的那几个，宁缺毋滥 */
const IRREGULAR: Record<string, string> = {
  men: 'man', women: 'woman', children: 'child', feet: 'foot', teeth: 'tooth',
  mice: 'mouse', geese: 'goose', people: 'person', oxen: 'ox', brethren: 'brother',
  analyses: 'analysis', diagnoses: 'diagnosis', theses: 'thesis', crises: 'crisis',
  hypotheses: 'hypothesis', parentheses: 'parenthesis',
  criteria: 'criterion', phenomena: 'phenomenon',
  indices: 'index', matrices: 'matrix', vertices: 'vertex', appendices: 'appendix',
}

/**
 * 词形还原候选：按常见后缀反推原形。
 * 不追求语言学正确，能覆盖考试词库里的规则变化即可。
 *
 * 顺序很重要：越可信的越靠前，调用方通常取第一个查得到的。
 */
export function lemmaCandidates(word: string): string[] {
  const w = word.toLowerCase()
  const out: string[] = [w]
  const add = (s: string) => {
    if (s.length >= 2 && !out.includes(s)) out.push(s)
  }

  // 规则变化
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y')
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y')
  if (w.endsWith('es')) add(w.slice(0, -2))
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1))
  // wives → wife / leaves → leaf / knives → knife
  if (w.endsWith('ves')) {
    add(w.slice(0, -3) + 'f')
    add(w.slice(0, -3) + 'fe')
  }
  // analyses → analysis（-es 只会得到 analyse，再补一条 -is）
  if (w.endsWith('ses')) add(w.slice(0, -2) + 'is')

  // 不规则复数
  const irregular = IRREGULAR[w]
  if (irregular) add(irregular)
  if (w.endsWith('ed')) {
    const stem = w.slice(0, -2)
    add(stem)
    add(w.slice(0, -1))
    // stopped → stopp → stop（去掉双写）
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1))
    }
    // studied → studi → study
    if (stem.endsWith('i')) add(stem.slice(0, -1) + 'y')
  }
  if (w.endsWith('ing')) {
    add(w.slice(0, -3))
    add(w.slice(0, -3) + 'e')
    // running → run（去掉双写）
    const stem = w.slice(0, -3)
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1))
    }
  }
  if (w.endsWith('est')) {
    const stem = w.slice(0, -3)
    add(stem)
    add(w.slice(0, -2))
    // happiest → happi → happy
    if (stem.endsWith('i')) add(stem.slice(0, -1) + 'y')
  }
  if (w.endsWith('er')) {
    const stem = w.slice(0, -2)
    add(stem)
    add(w.slice(0, -1))
    // happier → happi → happy
    if (stem.endsWith('i')) add(stem.slice(0, -1) + 'y')
  }

  return out
}

async function lookupLocal(word: string): Promise<string | null> {
  for (const cand of lemmaCandidates(word)) {
    const shard = await loadShard(shardKey(cand))
    const hit = shard[cand]
    if (hit) return hit
  }
  return null
}

/** 简单并发控制，避免一次性打爆免费接口 */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await fn(items[index])
    }
  })
  await Promise.all(workers)
}

/** MyMemory：免费、无需 key、带 CORS 头 */
async function lookupOnline(word: string): Promise<string | null> {
  const mem = GLOSS_MEMORY.get(word)
  if (mem) return mem

  const { value } = await Preferences.get({ key: GLOSS_PREFIX + word })
  if (value) {
    GLOSS_MEMORY.set(word, value)
    return value
  }

  try {
    const url =
      'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(word) +
      '&langpair=en|zh-CN'
    const res = await fetch(url)
    if (!res.ok) return null

    const json = (await res.json()) as {
      responseData?: { translatedText?: string }
      quotaFinished?: boolean
    }

    const raw = json.responseData?.translatedText?.trim()
    if (!raw) return null
    // 配额用尽或异常时，接口会在 translatedText 里返回提示语
    if (/MYMEMORY WARNING|NO QUERY SPECIFIED|QUERY LENGTH LIMIT/i.test(raw)) return null

    GLOSS_MEMORY.set(word, raw)
    void Preferences.set({ key: GLOSS_PREFIX + word, value: raw })
    return raw
  } catch {
    return null
  }
}

export interface LookupOptions {
  /** 是否允许联网兜底，默认跟随设置 */
  online?: boolean
  /**
   * 本地结果先回调一次。
   * 界面拿到就能立刻渲染，不必等在线请求 —— 否则几个短语会把整页释义拖住好几秒。
   */
  onLocal?: (found: Map<string, string>) => void
}

/**
 * 批量查词，返回 拼写（小写） → 释义。
 * 查不到的不会出现在结果里，界面据此显示占位而不是空白。
 */
export async function lookupWords(
  spellings: string[],
  opts: LookupOptions = {},
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (spellings.length === 0) return result

  const unique = [...new Set(spellings.map((s) => s.trim().toLowerCase()))].filter(Boolean)
  const missing: string[] = []

  for (const word of unique) {
    const gloss = await lookupLocal(word)
    if (gloss) result.set(word, gloss)
    else missing.push(word)
  }

  // 本地能查到的先交出去
  opts.onLocal?.(new Map(result))

  const allowOnline = opts.online ?? onlineEnabled
  if (allowOnline && missing.length > 0) {
    const batch = missing.slice(0, MAX_ONLINE_PER_CALL)
    await mapLimit(batch, ONLINE_CONCURRENCY, async (word) => {
      const gloss = await lookupOnline(word)
      if (gloss) result.set(word, gloss)
    })
  }

  return result
}

/** 单条查词，阅读功能点词时用 */
export async function lookupOne(text: string): Promise<string | null> {
  const key = text.trim().toLowerCase()
  if (!key) return null

  const local = await lookupLocal(key)
  if (local) return local

  if (onlineEnabled) return lookupOnline(key)
  return null
}
