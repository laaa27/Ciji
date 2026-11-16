import { useEffect, useRef, useState } from 'react'

/**
 * 秒表：`running` 为 true 时计时，false 时停在原地（再次为 true 接着走）。
 *
 * 用时间戳差值而不是每秒 +1：WebView 退后台时定时器会被冻结，
 * 按差值计算回前台后能补齐，不会少记。组件重挂载自然归零。
 */
export function useStopwatch(running: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  /** 已累计的秒数；running 期间跟随 elapsed，暂停时冻结在这里 */
  const baseRef = useRef(0)

  useEffect(() => {
    if (!running) return
    const start = Date.now() - baseRef.current * 1000
    const tick = () => {
      const secs = Math.floor((Date.now() - start) / 1000)
      baseRef.current = secs
      setElapsed(secs)
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [running])

  return elapsed
}
