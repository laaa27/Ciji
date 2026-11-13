import { useEffect } from 'react'

/**
 * 弹层打开期间锁住背后的页面滚动。
 *
 * 为什么需要：词卡是 `position: fixed` 的遮罩，但它在 DOM 上仍是 `.body`
 * （App 的滚动容器）的后代。触摸滑动时浏览器顺着祖先链找可滚容器，找到的还是
 * `.body` —— 于是弹层开着，背后的文章照样跟着手指滚。滚的不是当前视图，手感
 * 会比平时更「冲」（没有 overscroll 阻尼），手指压在底栏那一段更是同一个穿透滚动。
 *
 * 只改 overflow，不动 scrollTop：Android WebView 里 `overflow: hidden` 不会重置
 * 滚动位置，关掉弹层后原地恢复，不会跳。
 * （`position: fixed + top: -Npx` 那套适合需要精确控制滚动条的桌面场景，这里用不上。）
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return

    const scroller = document.querySelector<HTMLElement>('[data-scroller]')
    if (!scroller) return

    const prev = scroller.style.overflowY
    scroller.style.overflowY = 'hidden'
    return () => {
      scroller.style.overflowY = prev
    }
  }, [active])
}
