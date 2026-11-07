import { Preferences } from '@capacitor/preferences'
import { create } from 'zustand'

import { applyNativeAppearance } from '@/api/appearance'

/**
 * 主题：白天 / 深夜两套纸墨色，令牌在 ui/styles/tokens.css。
 *
 * 两个实现细节值得记：
 * 1. **启动瞬间不能闪**。Preferences 是异步的（原生读 SharedPreferences），
 *    等它回来再上色会先闪一帧浅色。所以额外往 localStorage 写一份同步镜像，
 *    模块加载时立刻套上，再由 load() 与真实存储对齐。
 * 2. **系统栏要一起变**。Android 15+ 是 edge-to-edge，系统栏透明、盖在正文上，
 *    只剩图标明暗要处理；但 Android 15 以下系统栏不透明、取的是主题里的浅色，
 *    只调图标就会变成白底浅图标的空白带。所以底色和图标都由 AppearancePlugin 一起设。
 */

export type ThemeName = 'light' | 'dark'

const K_THEME = 'theme'
const K_BOOT = 'theme_boot'

const PAPER: Record<ThemeName, string> = {
  light: '#f7f8f5',
  dark: '#121413',
}

function applyDom(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', PAPER[theme])
}

function applyNative(theme: ThemeName): void {
  // 状态栏 + 导航栏的底色与图标由原生插件一起处理，
  // 只改图标会留下「白底浅图标」的空白带（Android 15 以下必现）
  void applyNativeAppearance(theme === 'dark')
}

function applyTheme(theme: ThemeName): void {
  applyDom(theme)
  applyNative(theme)
}

function readBootTheme(): ThemeName {
  try {
    return localStorage.getItem(K_BOOT) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

const bootTheme = readBootTheme()
// 模块一加载就上色，早于 React 首帧
applyDom(bootTheme)

type ThemeState = {
  theme: ThemeName
  ready: boolean
  load: () => Promise<void>
  setTheme: (theme: ThemeName) => Promise<void>
}

export const useTheme = create<ThemeState>((set) => ({
  theme: bootTheme,
  ready: false,

  load: async () => {
    const { value } = await Preferences.get({ key: K_THEME })
    const theme: ThemeName = value === 'dark' ? 'dark' : 'light'
    applyTheme(theme)
    set({ theme, ready: true })
  },

  setTheme: async (theme) => {
    // 先上色再落盘：切换要即时，写存储慢一点无所谓
    applyTheme(theme)
    set({ theme })
    try {
      localStorage.setItem(K_BOOT, theme)
    } catch {
      // 隐私模式下 localStorage 可能不可用，不影响本次会话
    }
    await Preferences.set({ key: K_THEME, value: theme })
  },
}))
