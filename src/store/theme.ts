import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { StatusBar, Style } from '@capacitor/status-bar'
import { create } from 'zustand'

/**
 * 主题：白天 / 深夜两套纸墨色，令牌在 ui/styles/tokens.css。
 *
 * 两个实现细节值得记：
 * 1. **启动瞬间不能闪**。Preferences 是异步的（原生读 SharedPreferences），
 *    等它回来再上色会先闪一帧浅色。所以额外往 localStorage 写一份同步镜像，
 *    模块加载时立刻套上，再由 load() 与真实存储对齐。
 * 2. **安卓状态栏图标要跟着翻**。页面是 edge-to-edge，状态栏透明、盖在正文上，
 *    正文变深色后系统仍画深色图标，时间电量就看不见了。用 StatusBar 插件切
 *    Style.Dark（浅色图标）/ Style.Light（深色图标）。
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
  if (!Capacitor.isNativePlatform()) return
  // Style.Dark = 浅色文字（配深色背景），别按名字直觉用反
  const style = theme === 'dark' ? Style.Dark : Style.Light
  void StatusBar.setStyle({ style }).catch(() => {
    // 插件不可用（比如旧包）不该影响界面本身
  })
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
