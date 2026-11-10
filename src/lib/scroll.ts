/**
 * 滚动位置恢复。
 *
 * 为什么要重试：内容（本地快照、文章正文）是异步读出来的，首帧的高度往往不够，
 * 直接设 scrollTop 会被浏览器夹到当前可滚范围，等内容铺开后就停在半路了。
 * 所以隔一小会儿再试，直到滚到位（或放弃）。
 *
 * 这套「60ms 后首试、每次 120ms 重试、差值 < 2px 算到位、最多 6 次」原先在
 * App.tsx 和 ReadingPage 各写了一遍，连魔数都相同 —— 上次修阅读位置抖动时
 * 很容易只改了其中一处。收在这里，两边共用。
 */

export type RestoreScrollOptions = {
  /** 首次尝试前的延迟，等首屏内容排完 */
  delayMs?: number
  /** 每次重试的间隔 */
  retryMs?: number
  /** 最多重试几次 */
  maxTries?: number
  /** 差值小于这个像素数就认为到位了 */
  tolerance?: number
}

/**
 * 把容器滚到指定位置，返回取消函数（组件卸载时必须调用）。
 * `top <= 0` 直接跳过——没有记录位置就不用恢复。
 */
export function restoreScroll(
  el: HTMLElement | null,
  top: number,
  opts: RestoreScrollOptions = {},
): () => void {
  const { delayMs = 60, retryMs = 120, maxTries = 6, tolerance = 2 } = opts

  if (!el || top <= 0) return () => {}

  let timer = 0
  let tries = 0

  const tick = () => {
    el.scrollTop = top
    tries += 1
    // 滚不到那么深说明内容还没铺开，隔一会儿再试
    if (el.scrollTop < top - tolerance && tries < maxTries) {
      timer = window.setTimeout(tick, retryMs)
    }
  }

  timer = window.setTimeout(tick, delayMs)
  return () => window.clearTimeout(timer)
}
