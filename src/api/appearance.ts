import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * 系统栏外观（原生插件 AppearancePlugin）。
 *
 * 只做一件事：把状态栏、导航栏的**底色与图标明暗**跟当前主题对齐。
 *
 * 为什么不用 @capacitor/status-bar：
 * - 它管不到底部导航栏，深色主题下底部会留一条白带
 * - 它只改图标明暗、不改底色。Android 15+ 强制 edge-to-edge（系统栏透明）时看不出问题，
 *   但 Android 15 以下系统栏取主题里的浅色，于是「白底 + 浅色图标」= 一条纯白空白带
 */

interface AppearancePlugin {
  apply(options: { dark: boolean }): Promise<void>
}

const Appearance = registerPlugin<AppearancePlugin>('Appearance')

export async function applyNativeAppearance(dark: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    await Appearance.apply({ dark })
  } catch {
    // 插件缺失（比如换了旧包）不该影响界面本身
  }
}
