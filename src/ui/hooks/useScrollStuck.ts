import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * 吸顶相关的两个小工具。
 *
 * 滚动容器在 App 层（.body），页面组件拿不到它的 ref，
 * 所以这里按「向上找第一个可滚动祖先」处理 —— 不要写死类名，CSS Modules 会加后缀。
 */

export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return null
}

/** 元素当前是否正好贴在它的 sticky 阈值上 */
export function isStuckAtLine(el: HTMLElement, scroller: HTMLElement): boolean {
  const base = scroller.getBoundingClientRect().top
  // 阈值就是 CSS 里写的 top，可能是 max()/env() 之类，取计算值最稳
  const offset = parseFloat(getComputedStyle(el).top) || 0
  const top = el.getBoundingClientRect().top
  // 必须判「正好贴在阈值上」而不是「在阈值之上」：被下一个元素顶走的会变成负数，
  // 那种不该算悬浮（否则分隔线会跟着跑到屏幕外）
  return top <= base + offset + 0.5 && top >= base + offset - 2
}

/** 给单个吸顶元素用：返回它现在是否贴住了 */
export function useScrollStuck(ref: RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const scroller = findScrollParent(el)
    if (!scroller) return

    let raf = 0
    const update = () => {
      raf = 0
      // 切到别的栏目时页面是 display:none，量出来的坐标没意义，跳过
      if (el.offsetParent === null) return
      setStuck(isStuckAtLine(el, scroller))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    // 页码切换回来时也要重新量一次
    const observer = new MutationObserver(onScroll)
    observer.observe(el.parentElement ?? el, { attributes: true, attributeFilter: ['data-active'] })
    update()

    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      observer.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ref])

  return stuck
}

/** 给「一组同类型吸顶元素」用：返回每个 key 是否贴住（key 取自 data-stuck-key） */
export function useScrollStuckGroup(
  containerRef: RefObject<HTMLElement | null>,
  selector: string,
  keyAttr: string,
): Record<string, boolean> {
  const [stuck, setStuck] = useState<Record<string, boolean>>({})
  const raf = useRef(0)

  useEffect(() => {
    const page = containerRef.current
    if (!page) return
    const scroller = findScrollParent(page)
    if (!scroller) return

    const update = () => {
      raf.current = 0
      if (page.offsetParent === null) return

      const next: Record<string, boolean> = {}
      for (const el of page.querySelectorAll<HTMLElement>(selector)) {
        next[el.dataset[keyAttr] ?? ''] = isStuckAtLine(el, scroller)
      }

      setStuck((prev) => {
        const keys = Object.keys(next)
        if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k])) {
          return prev
        }
        return next
      })
    }

    const onScroll = () => {
      if (!raf.current) raf.current = requestAnimationFrame(update)
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    update()

    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [containerRef, selector, keyAttr])

  return stuck
}
