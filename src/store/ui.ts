import type { TabKey } from '@/ui/components/TabBar'

/**
 * 界面状态的持久化：停在哪个栏目、各栏目的滚动位置、阅读位置、生成页的选词草稿。
 *
 * 为什么不用 `@capacitor/preferences`：它是异步的桥调用，而「上次停在哪个栏目」
 * 必须在首帧之前就知道 —— 否则会先闪一帧「今日」再跳到「阅读」。
 * localStorage 在 WebView 里是同步的，进程被杀也照样留着，正合适。
 *
 * 边界：只放 UI 状态。业务数据（今日快照、文章、阅读时长）仍然走 data 层。
 */

const TAB_KEY = 'cjt.tab'
const SCROLL_PREFIX = 'cjt.scroll.'
const READ_PREFIX = 'cjt.read.'
const SHOW_ZH_KEY = 'cjt.showzh'
const GEN_KEY = 'cjt.gen'

export const TABS = ['today', 'history', 'reading', 'stats', 'settings'] as const

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 配额满 / 隐私模式：界面状态丢了不影响功能，不打扰用户
  }
}

function drop(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // 同上
  }
}

/* ── 当前栏目 ───────────────────────────── */

export function readTab(): TabKey {
  const raw = read(TAB_KEY)
  return TABS.includes(raw as (typeof TABS)[number]) ? (raw as TabKey) : 'today'
}

export function saveTab(tab: TabKey): void {
  write(TAB_KEY, tab)
}

/* ── 各栏目的滚动位置 ─────────────────────── */

export function readScroll(tab: TabKey): number {
  const n = Number(read(SCROLL_PREFIX + tab))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function saveScroll(tab: TabKey, top: number): void {
  write(SCROLL_PREFIX + tab, String(Math.max(0, Math.round(top))))
}

/* ── 译文开关 ─────────────────────────────── */

/**
 * 译文是否展开。
 *
 * 必须和阅读位置一起持久化：译文开与不开，同一篇文章的高度差很多，
 * 只存像素位置、不存译文状态的话，重启后按「译文关」渲染，位置就会错到别处去。
 */
export function readShowZh(): boolean {
  return read(SHOW_ZH_KEY) === 'true'
}

export function saveShowZh(on: boolean): void {
  write(SHOW_ZH_KEY, on ? 'true' : 'false')
}

/* ── 阅读位置（按文章 id 存，换文章自然失效） ── */

export function readReadPos(articleId: string): number {
  const n = Number(read(READ_PREFIX + articleId))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function saveReadPos(articleId: string, top: number): void {
  write(READ_PREFIX + articleId, String(Math.max(0, Math.round(top))))
}

export function clearReadPos(articleId: string): void {
  drop(READ_PREFIX + articleId)
}

/* ── 生成页的选词草稿 ─────────────────────── */

export type GenDraft = {
  date: string
  kinds: string[]
  selected: string[]
  savedAt: number
}

/** 超过这个时间的草稿不再恢复：几天前的选词拿回来只会让人困惑 */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

export function readGenDraft(): GenDraft | null {
  const raw = read(GEN_KEY)
  if (!raw) return null

  try {
    const d = JSON.parse(raw) as GenDraft
    if (!d?.date || !Array.isArray(d.kinds) || !Array.isArray(d.selected)) return null
    if (Date.now() - (d.savedAt ?? 0) > DRAFT_TTL_MS) return null
    return d
  } catch {
    return null
  }
}

export function saveGenDraft(draft: Omit<GenDraft, 'savedAt'>): void {
  write(GEN_KEY, JSON.stringify({ ...draft, savedAt: Date.now() }))
}

export function clearGenDraft(): void {
  drop(GEN_KEY)
}
