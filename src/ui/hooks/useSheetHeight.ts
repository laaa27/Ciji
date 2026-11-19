import { useLayoutEffect, useState, type RefObject } from 'react'

/**
 * 底部弹层的高度动画。
 *
 * 弹层内容是异步长出来的：释义先到、墨墨学习状态后到，AI 释义行与变形标签更晚。
 * `height: auto` 跟不上定值做过渡（auto → auto 不触发 transition），
 * 所以高度只能实测后交给壳子，由 CSS 的 `transition: height` 去插值 ——
 * 曲线与答题条的 grid 1fr↔0fr 同一支（0.26s / cubic-bezier(0.22, 1, 0.36, 1)），
 * 两处的手感才对得上。
 *
 * @param shellRef   壳子：负责 height 与 max-height 的那个元素
 * @param contentRef 内层：自然高度，padding 在它身上（padding 留在壳子上，高度收到 0 时
 *                   底部会留一条 padding 的空白）
 * @param open       false 时高度收回 0；调用方负责在过渡结束后再卸载
 */
export function useSheetHeight(
  shellRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  open: boolean,
): number {
  const [natural, setNatural] = useState(0)
  const [grown, setGrown] = useState(false)

  // 量内容，不量壳子：量壳子会量到自己正在过渡的高度，过渡跟着自己跑，成回授
  useLayoutEffect(() => {
    const shell = shellRef.current
    const content = contentRef.current
    if (!shell || !content) return

    const measure = () => {
      // 上限写在 CSS 的 max-height 上，这里读计算值，省得同一个 84vh 抄两遍；
      // 不在 JS 里夹一下的话，超高内容会「提前涨到顶」，收起时前半段又没动静
      const cap = Number.parseFloat(getComputedStyle(shell).maxHeight)
      const raw = content.getBoundingClientRect().height
      setNatural(Number.isFinite(cap) ? Math.min(raw, cap) : raw)
    }

    measure()
    // 一次性测量不够：AI 释义行、变形标签、自定义编辑框都在挂载之后才出现
    const ro = new ResizeObserver(measure)
    ro.observe(content)
    return () => ro.disconnect()
  }, [shellRef, contentRef])

  // 首帧必须留 0：和打开挤在同一次提交里就给到实测值，等于没有「展开」这回事
  useLayoutEffect(() => {
    if (!open) {
      setGrown(false)
      return
    }
    const id = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(id)
  }, [open])

  return open && grown ? natural : 0
}
