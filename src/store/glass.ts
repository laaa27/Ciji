import { Preferences } from '@capacitor/preferences'
import { create } from 'zustand'

/**
 * 液态玻璃底栏开关（默认关）。
 *
 * 开着时 TabBar 变成悬浮胶囊：backdrop-filter 模糊 + 提饱和，
 * 内容从栏下滚过透出玻璃质感。样式见 TabBar.module.css 的 data-glass 分支。
 */

const K_GLASS = 'liquid_glass'

type GlassState = {
  glass: boolean
  load: () => Promise<void>
  setGlass: (on: boolean) => Promise<void>
}

export const useGlass = create<GlassState>((set) => ({
  glass: false,

  load: async () => {
    const { value } = await Preferences.get({ key: K_GLASS })
    set({ glass: value === '1' })
  },

  setGlass: async (on) => {
    // 先生效再落盘：开关要即时
    set({ glass: on })
    await Preferences.set({ key: K_GLASS, value: on ? '1' : '0' })
  },
}))
