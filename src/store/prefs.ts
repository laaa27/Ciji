import { Preferences } from '@capacitor/preferences'
import { create } from 'zustand'

import { PREF_KEYS } from '@/data/keys'
import { MAX_TARGET_WORDS, WORD_LIMITS, type ArticleLevel } from '@/domain/prompts'

/**
 * 轻量偏好：字号、词数上限、难度、两个释义开关。
 *
 * 收在一个 store 里，是因为它们原先各自为政：字号在阅读页用 useState + useEffect 读、
 * 释义开关在两个页面各写一遍、难度在 props 回调里直接写盘。同一个模式写了五遍，
 * 每加一个偏好就要把四件套再抄一次。
 *
 * 边界：只放「单值、无生命周期」的偏好。
 * - `store/theme.ts` 不搬：它要在首帧之前同步上色，走 localStorage 镜像，机制不同
 *
 * 不新增动作（action）的写法也在这里统一：先改内存再落盘，开关要即时。
 */

export type FontSize = 's' | 'm' | 'l' | 'xl'

export type Prefs = {
  /** 阅读页正文字号 */
  readingFont: FontSize
  /** 一篇文章最多覆盖多少个目标词 */
  readingLimit: number
  /** 生成时的默认难度 */
  readingLevel: ArticleLevel
  /** 今日页释义是否展开 */
  glossToday: boolean
  /** 历史页释义是否展开 */
  glossHistory: boolean
}

const DEFAULTS: Prefs = {
  readingFont: 'm',
  readingLimit: MAX_TARGET_WORDS,
  readingLevel: 'kaoyan',
  glossToday: false,
  glossHistory: false,
}

function isFontSize(v: string | null): v is FontSize {
  return v === 's' || v === 'm' || v === 'l' || v === 'xl'
}

/** 雅思已从可选难度里去掉，读到时按默认档处理 */
function isLevel(v: string | null): v is ArticleLevel {
  return v === 'cet4' || v === 'cet6' || v === 'kaoyan'
}

/** 每个偏好一个解析器：存的是字符串，读坏了就回默认值，不让界面拿到脏数据 */
const PARSERS: { [P in keyof Prefs]: (raw: string | null) => Prefs[P] } = {
  readingFont: (raw) => (isFontSize(raw) ? raw : DEFAULTS.readingFont),
  readingLimit: (raw) => {
    const n = Number(raw)
    return WORD_LIMITS.includes(n) ? n : DEFAULTS.readingLimit
  },
  readingLevel: (raw) => (isLevel(raw) ? raw : DEFAULTS.readingLevel),
  glossToday: (raw) => raw === 'true',
  glossHistory: (raw) => raw === 'true',
}

/** 编译期保证：每个偏好字段都有对应的存储键 */
const KEY_MAP = PREF_KEYS satisfies Record<keyof Prefs, string>

type PrefsState = Prefs & {
  ready: boolean
  /** 启动时读一次全部偏好（App 挂载时调用） */
  load: () => Promise<void>
  set: <P extends keyof Prefs>(key: P, value: Prefs[P]) => void
}

export const usePrefs = create<PrefsState>((set) => ({
  ...DEFAULTS,
  ready: false,

  load: async () => {
    const [font, limit, level, glossToday, glossHistory] = await Promise.all([
      Preferences.get({ key: KEY_MAP.readingFont }),
      Preferences.get({ key: KEY_MAP.readingLimit }),
      Preferences.get({ key: KEY_MAP.readingLevel }),
      Preferences.get({ key: KEY_MAP.glossToday }),
      Preferences.get({ key: KEY_MAP.glossHistory }),
    ])

    set({
      readingFont: PARSERS.readingFont(font.value),
      readingLimit: PARSERS.readingLimit(limit.value),
      readingLevel: PARSERS.readingLevel(level.value),
      glossToday: PARSERS.glossToday(glossToday.value),
      glossHistory: PARSERS.glossHistory(glossHistory.value),
      ready: true,
    })
  },

  set: (key, value) => {
    set({ [key]: value } as Partial<Prefs>)
    void Preferences.set({ key: KEY_MAP[key], value: String(value) })
  },
}))
