import { create } from 'zustand'

/**
 * 全局轻提示。
 *
 * 用在「异步任务完成时用户可能已经离开当前页面」的场景 ——
 * 比如切去今日页之后文章才生成好，得有个地方告诉他。
 */

type ToastState = {
  message: string | null
  show: (message: string) => void
  clear: () => void
}

const DURATION_MS = 2600
let timer: ReturnType<typeof setTimeout> | undefined

export const useToast = create<ToastState>((set) => ({
  message: null,

  show: (message) => {
    set({ message })
    clearTimeout(timer)
    timer = setTimeout(() => set({ message: null }), DURATION_MS)
  },

  clear: () => {
    clearTimeout(timer)
    set({ message: null })
  },
}))
