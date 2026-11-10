import { useCallback, useEffect, useRef, useState } from 'react'

import { pushBackHandler } from '@/store/backstack'

/**
 * 二级视图的三件套：进出状态、返回动画、安卓返回键。
 *
 * 这三件事以前在每个二级页里各写一遍（阅读页的文章库、生成页，设置页的六个栏目），
 * 320ms 这个时长抄了四处，返回键也注册了四次 —— 少抄一条就漏（词卡那处就没有滚动记忆）。
 * 收在这里之后，加一个新的二级页只需要一行。
 *
 * 不做的事：滚动位置。各个二级页要不要记、记在哪，只有调用方知道，
 * 通过 onEnter / onExit 交给它自己处理。
 */

export type SubViewOptions = {
  /** 返回动画时长，必须与 CSS 里的过渡一致 */
  duration?: number
  /** 进入二级视图前（比如记住当前滚动位置） */
  onEnter?: () => void
  /** 退出二级视图后（比如恢复滚动位置） */
  onExit?: () => void
}

export function useSubView<T>(opts: SubViewOptions = {}) {
  const { duration = 320 } = opts

  /** 同时只可能有一个二级视图，天然互斥，不存在两个都开着的状态 */
  const [view, setView] = useState<T | null>(null)
  const [returning, setReturning] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  /**
   * 回调存 ref 而不是进依赖数组：调用方通常传内联箭头函数，
   * 进依赖会让 open/close 每次渲染都重建，返回键跟着反复注册。
   * 在 effect 里同步，避免渲染期间写 ref。
   */
  const enterRef = useRef(opts.onEnter)
  const exitRef = useRef(opts.onExit)
  useEffect(() => {
    enterRef.current = opts.onEnter
    exitRef.current = opts.onExit
  }, [opts.onEnter, opts.onExit])

  const open = useCallback((next: T) => {
    enterRef.current?.()
    setView(next)
  }, [])

  const close = useCallback(() => {
    setView(null)
    setReturning(true)
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setReturning(false), duration)
    exitRef.current?.()
  }, [duration])

  // 卸载时把定时器收掉，免得离开页面后还在 setState
  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  /** 有二级视图就自动接管返回键，调用方不用记着注册 */
  useEffect(() => {
    if (view === null) return
    return pushBackHandler(close)
  }, [view, close])

  return { view, returning, open, close, isOpen: view !== null }
}
