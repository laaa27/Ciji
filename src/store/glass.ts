import { Preferences } from '@capacitor/preferences'
import { create } from 'zustand'

/**
 * 液态玻璃底栏（默认关）+ 玻璃不透明度滑杆。
 *
 * 开着时 TabBar 变成悬浮胶囊：backdrop-filter 模糊 + 提饱和，
 * 内容从栏下滚过透出玻璃质感。样式见 TabBar.module.css 的 data-glass 分支。
 *
 * 不透明度走 CSS 变量 --glass-alpha（tokens.css 里按主题给了默认值），
 * 滑杆把覆盖值挂在 <html> 的内联样式上——改一个变量，两层主题都生效。
 */

const K_GLASS = 'liquid_glass'
const K_ALPHA = 'glass_alpha'

/** 滑杆范围与默认值（0.55 ≈ tokens.css 里浅色主题的默认） */
export const GLASS_ALPHA_MIN = 0
export const GLASS_ALPHA_MAX = 1
export const GLASS_ALPHA_DEFAULT = 0.55

type GlassState = {
  glass: boolean
  alpha: number
  load: () => Promise<void>
  setGlass: (on: boolean) => Promise<void>
  setAlpha: (v: number) => Promise<void>
}

function applyAlpha(alpha: number): void {
  document.documentElement.style.setProperty('--glass-alpha', alpha.toFixed(2))
}

export const useGlass = create<GlassState>((set) => ({
  glass: false,
  alpha: GLASS_ALPHA_DEFAULT,

  load: async () => {
    const [{ value }, { value: rawAlpha }] = await Promise.all([
      Preferences.get({ key: K_GLASS }),
      Preferences.get({ key: K_ALPHA }),
    ])
    const alpha = Number(rawAlpha)
    if (Number.isFinite(alpha) && alpha >= GLASS_ALPHA_MIN && alpha <= GLASS_ALPHA_MAX) {
      applyAlpha(alpha)
      set({ glass: value === '1', alpha })
    } else {
      set({ glass: value === '1' })
    }
  },

  setGlass: async (on) => {
    // 先生效再落盘：开关要即时
    set({ glass: on })
    await Preferences.set({ key: K_GLASS, value: on ? '1' : '0' })
  },

  setAlpha: async (v) => {
    const alpha = Math.min(GLASS_ALPHA_MAX, Math.max(GLASS_ALPHA_MIN, v))
    applyAlpha(alpha)
    set({ alpha })
    await Preferences.set({ key: K_ALPHA, value: alpha.toFixed(2) })
  },
}))
