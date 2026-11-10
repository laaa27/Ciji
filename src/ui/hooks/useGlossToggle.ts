import { useState } from 'react'

import { usePrefs } from '@/store/prefs'

/**
 * 释义展开开关：全局一个总闸（持久化），每个词可以单独覆盖。
 *
 * 今日页和历史页原先各写一遍同样的五段逻辑（showGloss / overrides / toggle /
 * toggleAll / 读持久化），只有存储键不同。收成一个 hook，以后加「按反馈类型过滤」之类
 * 只改这里。
 *
 * 覆盖态（overrides）是瞬态，不落盘：重启后回到统一状态才符合预期。
 */
export function useGlossToggle(which: 'glossToday' | 'glossHistory') {
  const showGloss = usePrefs((s) => s[which])
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  return {
    /** 全局总闸的当前值 */
    showGloss,
    /** 某个词最终该不该展开：单次覆盖优先于总闸 */
    isShown: (vocId: string) => overrides[vocId] ?? showGloss,
    /** 单个词：点一下切一次 */
    toggle: (vocId: string) =>
      setOverrides((prev) => ({ ...prev, [vocId]: !(prev[vocId] ?? showGloss) })),
    /** 总闸：切的时候清掉个体覆盖，回到统一状态 */
    toggleAll: () => {
      setOverrides({})
      usePrefs.getState().set(which, !showGloss)
    },
  }
}
