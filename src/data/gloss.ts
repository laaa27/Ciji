import { Preferences } from '@capacitor/preferences'

/**
 * 释义缓存：主释义（`gloss:<词>`）与备选释义（`gloss_alt:<词>`）。
 *
 * 单独一个文件，是因为这些键是"永久缓存"，读写必须一致：来源标记、内存上限、
 * 写失败降级三件事同进同出。原先混在查词编排里，加一个备选释义就要翻七百行。
 */

/**
 * 释义缓存条目。`ai` 是给界面用的来源标记，必须与释义一起持久化——
 * 否则首次查（走 AI）有标注、二次查（命中缓存）标注丢失，同一个词两副面孔。
 */
interface GlossEntry {
  gloss: string
  /** 这条释义是不是 AI 产生的（本地词典 / MyMemory 都是 false） */
  ai: boolean
}

const GLOSS_MEMORY = new Map<string, GlossEntry>()

const GLOSS_PREFIX = 'gloss:'

/**
 * 内存里最多留多少条释义。
 * 真正的持久层是 Preferences，这里只是热缓存；没有上限的话长期运行会一直涨。
 * Map 的迭代顺序就是插入顺序，所以淘汰最旧的一条即可（命中时不重排，够用）。
 */
const GLOSS_MEMORY_MAX = 2000

/** 释义缓存读取（AI 与在线兜底共用同一个缓存，都是永久保存） */
export async function cachedGloss(word: string): Promise<GlossEntry | null> {
  const mem = GLOSS_MEMORY.get(word)
  if (mem) return mem

  const { value } = await Preferences.get({ key: GLOSS_PREFIX + word })
  if (!value) return null

  const entry = parseGlossEntry(value)
  keepInMemory(word, entry)
  return entry
}

/**
 * 缓存值解析。加来源标记之前写入的是纯文本，没有来源信息——
 * 一律当作非 AI，不猜：猜错会把 MyMemory 的词对词死译也标成 AI 释义。
 */
function parseGlossEntry(raw: string): GlossEntry {
  if (raw.startsWith('{')) {
    try {
      const data = JSON.parse(raw) as { gloss?: unknown; ai?: unknown }
      if (typeof data.gloss === 'string' && data.gloss) {
        return { gloss: data.gloss, ai: data.ai === true }
      }
    } catch {
      // 内容不合法就落到下面：原样当释义返回，至少不丢已缓存的文字
    }
  }
  return { gloss: raw, ai: false }
}

/** 往热缓存里放一条，超过上限就淘汰最旧的一条（持久层是 Preferences，不影响落盘） */
function keepInMemory(word: string, entry: GlossEntry): void {
  GLOSS_MEMORY.delete(word)
  GLOSS_MEMORY.set(word, entry)
  while (GLOSS_MEMORY.size > GLOSS_MEMORY_MAX) {
    const oldest = GLOSS_MEMORY.keys().next().value
    if (oldest === undefined) break
    GLOSS_MEMORY.delete(oldest)
  }
}

/**
 * 写释义缓存：同一个词这辈子只问一次模型，来源标记跟着释义一起落盘。
 *
 * `Preferences.set` 必须接住失败：Web 端 localStorage 有 5 MB 配额，溢出会 reject；
 * 不接就是一条 unhandled rejection，界面上完全看不出来（内存里还有，下次冷启动就没了）。
 * 写不进去只降级成「本次会话有效」，不影响这一次显示。
 */
export function rememberGloss(word: string, gloss: string, ai: boolean): void {
  const entry: GlossEntry = { gloss, ai }
  keepInMemory(word, entry)
  void Preferences.set({ key: GLOSS_PREFIX + word, value: JSON.stringify(entry) }).catch(() => {})
}

/* ── 备选释义：与主释义并存，只在词卡里展示 ─────────── */

/**
 * 一个词的备选释义。
 *
 * 主释义（`gloss:<词>`）仍是"查出来的那一条"，界面上永远显示；
 * 备选是用户主动要来的第二、第三条，并存而不是替换：
 * - `ai`：用户点「AI 释义」让模型写的版本（主释义是本地词典时才有意义）
 * - `custom`：用户自己填的
 *
 * 单独一个键而不是改 `gloss:<词>` 的结构：老用户几千条缓存零迁移，
 * 出问题也能直接停用而不影响已有释义。
 */
export interface GlossAlt {
  ai?: string
  custom?: string
}

const ALT_PREFIX = 'gloss_alt:'

/** 读备选释义。读坏了当没有，不让界面拿到脏数据 */
export async function readGlossAlt(word: string): Promise<GlossAlt> {
  const key = word.trim().toLowerCase()
  if (!key) return {}

  const { value } = await Preferences.get({ key: ALT_PREFIX + key })
  if (!value) return {}

  try {
    const raw = JSON.parse(value) as { ai?: unknown; custom?: unknown }
    const out: GlossAlt = {}
    if (typeof raw.ai === 'string' && raw.ai.trim()) out.ai = raw.ai.trim()
    if (typeof raw.custom === 'string' && raw.custom.trim()) out.custom = raw.custom.trim()
    return out
  } catch {
    return {}
  }
}

/** 写备选释义；两个字段都空就把键删掉，不留空壳 */
export async function saveGlossAlt(word: string, alt: GlossAlt): Promise<void> {
  const key = word.trim().toLowerCase()
  if (!key) return

  const ai = alt.ai?.trim()
  const custom = alt.custom?.trim()
  const value = JSON.stringify({ ...(ai ? { ai } : {}), ...(custom ? { custom } : {}) })

  if (!ai && !custom) {
    await Preferences.remove({ key: ALT_PREFIX + key }).catch(() => {})
    return
  }
  await Preferences.set({ key: ALT_PREFIX + key, value }).catch(() => {})
}

/**
 * 问模型要一条释义（跳过本地词典与缓存，就是"再问一次"）。
 *
 * `asMain`：主释义本身就是 AI 给的（这个词本地没收录、当初由 AI 兜底生成），
 * 那时"重新生成"应当更新主释义，而不是再堆一条一模一样的备选。
 * 返回 null 表示没配模型或调用失败——界面据此提示，不要假装成功。
 */
