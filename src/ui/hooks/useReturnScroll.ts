import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'

import { findScrollParent } from './useScrollStuck'

/**
 * 二级视图往返时的滚动位置记忆。
 *
 * 以前这件事在四处各写一遍（历史页进统计、阅读页进文章库/生成、训练页进套卷/做题、
 * 生成页进日历），规则还不一致：有的在进入前存位置、有的在 effect 里存；有的返回时
 * 位置为 0 就不动、有的无条件写回。收在这里之后，各处只把 onEnter / onExit 交给
 * `useSubView`，不再自己写 ref + effect。
 *
 * 两个时序细节决定了实现形状（都是踩过的坑，别改回去）：
 *
 * 1. **归零与恢复都放到 rAF 里**。onEnter 是在 `setView` 之前调的，此时滚动容器里还是
 *    旧内容、页面里的 scroll 监听也还挂着。同步写 `scrollTop` 会立刻产生一次 scroll
 *    事件，把「最后可见位置」冲成 0/顶部值——切回来就落在错的地方。rAF 跑在 React
 *    提交之后，那时旧监听已经 cleanup 掉了。
 * 2. **只有真正进过才恢复**。首次挂载时 onEnter 没被调过，onExit 自然也不该动位置，
 *    否则会把 `App` 记下的栏目位置（冷启动恢复）覆盖成 0。
 */
export type ReturnScrollOptions = {
  /** 进入子视图时把容器滚到顶部（列表类二级页从顶部看）。默认 true */
  topOnEnter?: boolean
}

export type ReturnScroll = {
  /** 记下当前可见位置（一般不用手动调，onEnter 会做） */
  capture: () => void
  /** 把外部已知的位置灌进来（阅读页冷启动恢复时要与落盘值保持同一份） */
  seek: (top: number) => void
  /** 交给 `useSubView` 的 onEnter */
  onEnter: () => void
  /** 交给 `useSubView` 的 onExit */
  onExit: () => void
}

export function useReturnScroll(
  containerRef: RefObject<HTMLElement | null>,
  { topOnEnter = true }: ReturnScrollOptions = {},
): ReturnScroll {
  /** 进子视图那一刻的位置；返回时用它 */
  const pos = useRef(0)
  /** 是否真的经历过一次「进入」，避免首帧 onExit 抢走 App 的栏目位置 */
  const entered = useRef(false)
  const raf = useRef(0)

  const capture = useCallback(() => {
    const el = findScrollParent(containerRef.current)
    if (el) pos.current = el.scrollTop
  }, [containerRef])

  const seek = useCallback((top: number) => {
    pos.current = top
  }, [])

  const onEnter = useCallback(() => {
    capture()
    entered.current = true
    if (!topOnEnter) return

    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      const el = findScrollParent(containerRef.current)
      if (el) el.scrollTop = 0
    })
  }, [capture, containerRef, topOnEnter])

  const onExit = useCallback(() => {
    if (!entered.current) return
    entered.current = false

    const el = findScrollParent(containerRef.current)
    if (!el) return

    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      el.scrollTop = pos.current
    })
  }, [containerRef])

  // 卸载时把挂起的 rAF 收掉，免得离开页面后还在动别人的滚动容器
  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  return { capture, seek, onEnter, onExit }
}
