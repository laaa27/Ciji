import { create } from 'zustand'

/**
 * 安卓返回键的拦截栈。
 *
 * 默认行为是「连按两次退出 App」，但页面进入了子视图（文章库、词卡）时，
 * 返回键应该先退一层 —— 这是安卓用户的肌肉记忆，按错一次就是直接退出，很恼人。
 *
 * 用栈而不是单个回调：子视图可以叠加，后进的先退。
 */

type BackHandler = () => void

type BackState = {
  handlers: BackHandler[]
  push: (handler: BackHandler) => () => void
  /** 有拦截器就交给栈顶并返回 true；否则返回 false，由调用方走默认行为 */
  handle: () => boolean
}

export const useBackStack = create<BackState>((set, get) => ({
  handlers: [],

  push: (handler) => {
    set({ handlers: [...get().handlers, handler] })
    // 注销时要按引用移除，别用下标 —— 中间可能有别的层出入
    return () => {
      set({ handlers: get().handlers.filter((h) => h !== handler) })
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
