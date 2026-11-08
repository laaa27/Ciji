import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

/**
 * 预测性返回手势的原生桥（app 内插件，MainActivity 注册）。
 *
 * 仅 Android 14+ 有进度事件；更低版本上 setEnabled 是空操作，
 * 调用方不用关心，返回行为自动回落到 Capacitor 的 backButton。
 */
export type PredictiveBackPlugin = {
  setEnabled(opts: { enabled: boolean }): Promise<void>
  addListener(
    eventName: 'started' | 'progress' | 'cancelled' | 'commit',
    cb: (data: { progress: number }) => void,
  ): Promise<PluginListenerHandle>
}

export const PredictiveBack = registerPlugin<PredictiveBackPlugin>('PredictiveBack')
