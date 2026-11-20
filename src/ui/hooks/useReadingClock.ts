import { useEffect, useRef, useState } from 'react'

import { addReadingSeconds, getReadingSeconds } from '@/data/reading'

/**
 * 内存里攒够这么多秒才落盘一次。
 *
 * 0.24.26 起一眼一天一个文件，落盘是「读当天 23 KB → 加秒 → 写回」，
 * 不再是整份 SharedPreferences 重写，所以不必卡着 15 秒那么紧；
 * 一分钟一次足够，把写次数再降四倍。
 */
const FLUSH_SEC = 60

/**
 * 阅读计时：只在真正读文章时走秒，切后台不计。
 *
 * 秒数分两层：`todaySeconds` 是界面上显示的「今天累计」（已落盘 + 本次会话正在攒的），
 * 内存里另攒一份，够一分钟或离开计时状态时一次性落盘 —— 每秒都写存储会卡。
 *
 * 从 ReadingPage 搬出来时保持行为完全一致，包括两个容易踩的点：
 * 1. 切后台时 WebView 的定时器不可靠，`document.hidden` 期间的秒数不能算
 * 2. 用户切到后台那一刻要先把攒着的秒数冲刷掉，否则进程被回收就丢了
 */
export function useReadingClock(today: string, counting: boolean): number {
  const [todaySeconds, setTodaySeconds] = useState(0)
  const sessionRef = useRef(0)

  useEffect(() => {
    void getReadingSeconds(today).then(setTodaySeconds)
  }, [today])

  useEffect(() => {
    if (!counting) return

    const flush = () => {
      const sec = sessionRef.current
      if (sec <= 0) return
      sessionRef.current = 0
      void addReadingSeconds(today, sec)
    }

    const id = window.setInterval(() => {
      if (document.hidden) return
      sessionRef.current += 1
      setTodaySeconds((s) => s + 1)
      if (sessionRef.current >= FLUSH_SEC) flush()
    }, 1000)

    const onVisibility = () => {
      if (document.hidden) flush()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
      flush()
    }
  }, [counting, today])

  return todaySeconds
}
