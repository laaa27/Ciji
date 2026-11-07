import { create } from 'zustand'

import { saveDay } from '@/data/store'
import { collectToday, type TodaySnapshot } from '@/domain/collect'
import { dateKey } from '@/lib/date'

type Status = 'idle' | 'loading' | 'ok' | 'error'

type TodayState = {
  snapshot: TodaySnapshot | null
  status: Status
  error: string | null

  /** 拉一次今天的数据。force=false 时若已有今天的数据则不重复请求 */
  refresh: (force?: boolean) => Promise<void>
  /** 清空（换 token 时调用） */
  reset: () => void
}

export const useToday = create<TodayState>((set, get) => ({
  snapshot: null,
  status: 'idle',
  error: null,

  refresh: async (force = false) => {
    const { snapshot, status } = get()
    if (status === 'loading') return
    if (!force && snapshot && snapshot.date === dateKey()) return

    set({ status: 'loading', error: null })

    try {
      const next = await collectToday()
      // 每次都落盘；同一天重复采集直接覆盖，保证幂等
      await saveDay(next)
      set({ snapshot: next, status: 'ok', error: null })
    } catch (e) {
      set({
        status: 'error',
        error: e instanceof Error ? e.message : '采集失败，请稍后重试',
      })
    }
  },

  reset: () => set({ snapshot: null, status: 'idle', error: null }),
}))
