import { Preferences } from '@capacitor/preferences'

import { queueByKey, readJson, removeFile, writeJson } from '@/data/files'

/**
 * 释义缓存：主释义（`cache/gloss.json`）与备选释义（`cache/gloss_alt.json`）。
 *
 * 0.24.26 起从 Preferences 搬到文件：两族键加起来能到几千条，而 Preferences 是
 * 「所有键共用一个 XML、每次写全量重写」——查一个词就要把整份文件重写一遍。
 * 搬成「一个文件装一个 map」之后，写完顺手把内存里的 map 当缓存，读也不再走桥。
 *
 * 两个 map 分开存：主释义可再生（重查一次就回来），备选释义里有用户手填的，
 * 丢了就是真丢数据 —— 清缓存时只能清前者。
 */

interface GlossEntry {
  gloss: string
  /** 这条释义是不是 AI 产生的（本地词典 / MyMemory 都是 false） */
  ai: boolean
  /** 落盘时刻（毫秒）。磁盘上限按它淘汰最旧的；旧数据没有此字段，视为最早 */
  t?: number
}

/**
 * 备选释义：与主释义并存，只在词卡里展示。
 *
 * - `ai`：用户点「AI 释义」让模型写的版本（主释义是本地词典时才有意义）
 * - `custom`：用户自己填的
 */
export interface GlossAlt {
  ai?: string
  custom?: string
}

const GLOSS_PATH = 'cache/gloss.json'
const ALT_PATH = 'cache/gloss_alt.json'

/** 迁移前的旧键前缀（0.24.26 之前） */
const GLOSS_PREFIX = 'gloss:'
const ALT_PREFIX = 'gloss_alt:'

const K_GLOSS_MIGRATED = 'gloss_migrated'
const K_ALT_MIGRATED = 'gloss_alt_migrated'

/** 搬迁前的原件副本，出问题能照着还原 */
const SAFETY_PATH = 'migration/legacy-gloss.json'

/**
 * 磁盘上限：主释义超过这个数就按落盘时刻淘汰最旧的。
 * 只淘汰 `gloss:`——它们可再生；`gloss_alt:` 有用户自填的，不动。
 */
const GLOSS_MAX = 3000

let glossLoading: Promise<Map<string, GlossEntry>> | null = null
let altLoading: Promise<Map<string, GlossAlt>> | null = null

/* ── 主释义 ─────────────────────────────── */

/** 释义缓存读取（AI 与在线兜底共用同一个缓存，都是永久保存） */
export async function cachedGloss(word: string): Promise<GlossEntry | null> {
  const map = await loadGlossMap()
  return map.get(word) ?? null
}

/**
 * 缓存值解析。加来源标记之前写入的是纯文本，没有来源信息——
 * 一律当作非 AI，不猜：猜错会把 MyMemory 的词对词死译也标成 AI 释义。
 */
function parseGlossEntry(raw: string): GlossEntry {
  if (raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw) as { gloss?: unknown; ai?: unknown; t?: unknown }
      if (typeof data.gloss === 'string' && data.gloss) {
        return {
          gloss: data.gloss,
          ai: data.ai === true,
          ...(typeof data.t === 'number' ? { t: data.t } : {}),
        }
      }
    } catch {
      // 内容不合法就落到下面：原样当释义返回，至少不丢已缓存的文字
    }
  }
  return { gloss: raw, ai: false }
}

/** 文件里的一条（已是结构化数据，不再有旧纯文本那种形态） */
function entryOf(value: unknown): GlossEntry | null {
  if (!value || typeof value !== 'object') return null
  const data = value as { gloss?: unknown; ai?: unknown; t?: unknown }
  if (typeof data.gloss !== 'string' || !data.gloss) return null
  return {
    gloss: data.gloss,
    ai: data.ai === true,
    ...(typeof data.t === 'number' ? { t: data.t } : {}),
  }
}

function loadGlossMap(): Promise<Map<string, GlossEntry>> {
  if (!glossLoading) {
    glossLoading = (async () => {
      const raw = await readJson<Record<string, unknown>>(GLOSS_PATH)
      const map = new Map<string, GlossEntry>()
      for (const [word, value] of Object.entries(raw ?? {})) {
        const entry = entryOf(value)
        if (entry) map.set(word, entry)
      }
      await mergeLegacyGloss(map)
      return map
    })().catch((e: unknown) => {
      // 读失败不能把失败状态钉死在这个会话里，下次调用重新来过
      glossLoading = null
      throw e
    })
  }
  return glossLoading
}

/**
 * 一次性迁移：把 `gloss:<词>` 搬进文件。
 *
 * 先落原件、再写文件、最后删键：任何一步失败旧键都还在，最坏结果只是这些键继续
 * 占着 XML（慢一点），不存在「缓存没了」这种结果。
 */
async function mergeLegacyGloss(map: Map<string, GlossEntry>): Promise<void> {
  if (await isMarked(K_GLOSS_MIGRATED)) return

  const { keys } = await Preferences.keys()
  const legacy = keys.filter((k) => k.startsWith(GLOSS_PREFIX))
  if (legacy.length === 0) {
    await mark(K_GLOSS_MIGRATED)
    return
  }

  const raw = await readLegacyValues(legacy, GLOSS_PREFIX)
  if (Object.keys(raw).length > 0) await writeSafetyDump(raw)

  let changed = false
  for (const [word, value] of Object.entries(raw)) {
    if (map.has(word)) continue
    map.set(word, parseGlossEntry(value))
    changed = true
  }
  if (changed) {
    pruneGloss(map)
    await persistGloss(map)
  }

  for (const key of legacy) await Preferences.remove({ key }).catch(() => {})
  await mark(K_GLOSS_MIGRATED)
}

/**
 * 写主释义缓存：同一个词这辈子只问一次模型，来源标记跟着释义一起落盘。
 *
 * 写文件不接住失败就是一条 unhandled rejection，界面上完全看不出来
 * （内存里还有，下次冷启动就没了）。写不进去只降级成「本次会话有效」。
 */
export function rememberGloss(word: string, gloss: string, ai: boolean): void {
  const entry: GlossEntry = { gloss, ai, t: Date.now() }
  void loadGlossMap()
    .then((map) => {
      map.set(word, entry)
      pruneGloss(map)
      return persistGloss(map)
    })
    .catch(() => {})
}

function persistGloss(map: Map<string, GlossEntry>): Promise<void> {
  return queueByKey(GLOSS_PATH, () => writeJson(GLOSS_PATH, Object.fromEntries(map)))
}

/** 超过上限就淘汰最旧的；旧数据没有 `t`，按最早处理 */
function pruneGloss(map: Map<string, GlossEntry>): void {
  if (map.size <= GLOSS_MAX) return
  const victims = [...map.entries()]
    .sort((a, b) => (a[1].t ?? 0) - (b[1].t ?? 0))
    .slice(0, map.size - GLOSS_MAX)
  for (const [word] of victims) map.delete(word)
}

/* ── 备选释义 ────────────────────────────── */

/** 读备选释义。读坏了当没有，不让界面拿到脏数据 */
export async function readGlossAlt(word: string): Promise<GlossAlt> {
  const key = word.trim().toLowerCase()
  if (!key) return {}
  const map = await loadAltMap()
  return map.get(key) ?? {}
}

/** 写备选释义；两个字段都空就把那条删掉，不留空壳 */
export async function saveGlossAlt(word: string, alt: GlossAlt): Promise<void> {
  const key = word.trim().toLowerCase()
  if (!key) return

  const ai = alt.ai?.trim()
  const custom = alt.custom?.trim()
  const map = await loadAltMap()

  if (!ai && !custom) map.delete(key)
  else map.set(key, { ...(ai ? { ai } : {}), ...(custom ? { custom } : {}) })

  await persistAlt(map)
}

function loadAltMap(): Promise<Map<string, GlossAlt>> {
  if (!altLoading) {
    altLoading = (async () => {
      const raw = await readJson<Record<string, unknown>>(ALT_PATH)
      const map = new Map<string, GlossAlt>()
      for (const [word, value] of Object.entries(raw ?? {})) {
        const alt = altOf(value)
        if (alt) map.set(word, alt)
      }
      await mergeLegacyAlt(map)
      return map
    })().catch((e: unknown) => {
      altLoading = null
      throw e
    })
  }
  return altLoading
}

function altOf(value: unknown): GlossAlt | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { ai?: unknown; custom?: unknown }
  const out: GlossAlt = {}
  if (typeof raw.ai === 'string' && raw.ai.trim()) out.ai = raw.ai.trim()
  if (typeof raw.custom === 'string' && raw.custom.trim()) out.custom = raw.custom.trim()
  return out.ai || out.custom ? out : null
}

/** 备选释义里有手填内容（不可再生），迁移同样先落原件、写成功才删旧键 */
async function mergeLegacyAlt(map: Map<string, GlossAlt>): Promise<void> {
  if (await isMarked(K_ALT_MIGRATED)) return

  const { keys } = await Preferences.keys()
  const legacy = keys.filter((k) => k.startsWith(ALT_PREFIX))
  if (legacy.length === 0) {
    await mark(K_ALT_MIGRATED)
    return
  }

  const raw = await readLegacyValues(legacy, ALT_PREFIX)
  if (Object.keys(raw).length > 0) await writeSafetyDump(raw)

  let changed = false
  for (const [word, value] of Object.entries(raw)) {
    if (map.has(word)) continue
    try {
      const alt = altOf(JSON.parse(value) as unknown)
      if (alt) {
        map.set(word, alt)
        changed = true
      }
    } catch {
      // 坏掉的那条跳过；原文仍在副本里
    }
  }
  if (changed) await persistAlt(map)

  for (const key of legacy) await Preferences.remove({ key }).catch(() => {})
  await mark(K_ALT_MIGRATED)
}

function persistAlt(map: Map<string, GlossAlt>): Promise<void> {
  return queueByKey(ALT_PATH, () => writeJson(ALT_PATH, Object.fromEntries(map)))
}

/* ── 迁移辅助 ────────────────────────────── */

async function isMarked(key: string): Promise<boolean> {
  const { value } = await Preferences.get({ key })
  return value === '1'
}

async function mark(key: string): Promise<void> {
  await Preferences.set({ key, value: '1' }).catch(() => {})
}

/** 把一批旧键的原始值读出来（键 → 原文字符串），迁移与副本共用 */
async function readLegacyValues(
  keys: string[],
  prefix: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const { value } = await Preferences.get({ key })
    if (value !== null) out[key.slice(prefix.length)] = value
  }
  return out
}

/**
 * 把旧键原样写成一份副本，读回校验后才返回。
 * 校验不过就抛错——宁可这批缓存留在慢的存储里，也不冒丢数据的风险。
 */
async function writeSafetyDump(raw: Record<string, string>): Promise<void> {
  const payload = { at: new Date().toISOString(), raw }
  await writeJson(SAFETY_PATH, payload)
  const back = await readJson<{ raw?: Record<string, string> }>(SAFETY_PATH)
  const words = Object.keys(raw)
  const ok =
    back?.raw !== undefined &&
    words.every((w) => back.raw?.[w] === raw[w]) &&
    Object.keys(back.raw).length === words.length
  if (!ok) throw new Error('释义缓存副本校验失败')
}

/**
 * 清空主释义缓存（`gloss:<词>`）。
 *
 * 只清主释义：它们是查出来的、可再生；`gloss_alt:` 里有用户手填的释义，
 * 以前按前缀一起删，必须点两次确认兜着——现在不再碰它们。
 * 返回清掉的条数。
 */
export async function clearGlossCache(): Promise<number> {
  const map = await loadGlossMap()
  const count = map.size
  map.clear()
  await queueByKey(GLOSS_PATH, () => removeFile(GLOSS_PATH))

  // 迁移没跑完时旧键还在，一并清掉（不然下次启动又搬回来）
  const { keys } = await Preferences.keys()
  const legacy = keys.filter((k) => k.startsWith(GLOSS_PREFIX))
  for (const key of legacy) await Preferences.remove({ key }).catch(() => {})

  return count
}
