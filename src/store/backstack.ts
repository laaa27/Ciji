import { Capacitor } from '@capacitor/core'
import { create } from 'zustand'

import { PredictiveBack } from '@/native/predictive-back'
import { getPredictiveBackEnabled, setPredictiveBackEnabled } from '@/data/settings'

/**
 * 安卓返回键的拦截栈 + 预测性返回手势。
 *
 * 默认行为是「连按两次退出 App」，但页面进入了子视图（文章库、词卡）时，
 * 返回键应该先退一层 —— 这是安卓用户的肌肉记忆，按错一次就是直接退出，很恼人。
 *
 * 用栈而不是单个回调：子视图可以叠加，后进的先退。
 *
 * 预测性返回（Android 14+，设置里可开关）：栈非空时向原生注册
 * OnBackInvokedCallback，系统把手势过程实时推给 JS —— progress 驱动跟手
 * 动画，commit 相当于按了一次返回键，cancelled 让动画弹回去。栈空后注销
 * 回调，返回交给 Capacitor 原路（双击退出），根层级行为不变。
 */

type BackHandler = () => void

type BackState = {
  handlers: BackHandler[]
  push: (handler: BackHandler) => () => void
  /** 有拦截器就交给栈顶并返回 true；否则返回 false，由调用方走默认行为 */
  handle: () => boolean
}

/** 手势进行中的广播：只有当前可见的子视图会订阅 */
type ProgressListener = (progress: number) => void
const progressListeners = new Set<ProgressListener>()
const cancelListeners = new Set<() => void>()

/** 订阅手势进度（0→1）。返回注销函数。 */
export function onBackProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener)
  return () => progressListeners.delete(listener)
}

/** 订阅手势取消（中途松手），子视图动画弹回原位。返回注销函数。 */
export function onBackCancel(listener: () => void): () => void {
  cancelListeners.add(listener)
  return () => cancelListeners.delete(listener)
}

const onNative = Capacitor.isNativePlatform()

if (onNative) {
  void PredictiveBack.addListener('commit', () => {
    handleBack()
  })
  void PredictiveBack.addListener('progress', (d) => {
    for (const l of progressListeners) l(d.progress)
  })
  void PredictiveBack.addListener('cancelled', () => {
    for (const l of cancelListeners) l()
  })
}

/** 栈非空且开关打开时才占用系统回调；失败静默（老设备上 setEnabled 是空操作） */
function syncNative(count: number) {
  if (!onNative) return
  const on = count > 0 && getPredictiveBackEnabled()
  void PredictiveBack.setEnabled({ enabled: on }).catch(() => {})
}

export const useBackStack = create<BackState>((set, get) => ({
  handlers: [],

  push: (handler) => {
    set({ handlers: [...get().handlers, handler] })
    syncNative(get().handlers.length)
    // 注销时要按引用移除，别用下标 —— 中间可能有别的层出入
    return () => {
      set({ handlers: get().handlers.filter((h) => h !== handler) })
      syncNative(get().handlers.length)
    }
  },

  handle: () => {
    const stack = get().handlers
    const top = stack[stack.length - 1]
    if (!top) return false
    top()
    return true
  },
}))

/** 给非组件代码用（比如原生事件的回调里） */
export function pushBackHandler(handler: BackHandler): () => void {
  return useBackStack.getState().push(handler)
}

export function handleBack(): boolean {
  return useBackStack.getState().handle()
}

/** 设置里的开关变化后调用：更新持久化，并立即重算原生回调的启停 */
export function applyPredictiveBackSetting(enabled: boolean) {
  setPredictiveBackEnabled(enabled)
  syncNative(useBackStack.getState().handlers.length)
}
