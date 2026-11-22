import { useEffect, useState } from 'react'

import { addToPlan, advanceWord, lookupMemoState, type MemoState } from '@/domain/memo'
import { useSession } from '@/store/session'

/**
 * 词卡里的墨墨状态与两个写操作。
 *
 * 从 `WordSheet` 里搬出来的：这段有 5 个状态（状态 / 读取中 / 确认中 / 加入中 /
 * 提前复习中）、2 个写接口和 1 个提示。**加词会消耗用户当天额度**，是这一屏里
 * 唯一有副作用的操作，不该和「显示释义」的代码混在一起改样式。
 *
 * 顺带产出 `base`（变形族的基准词）：原词不在词库时要退到猜出来的原形，
 * 这份判断只在墨墨状态里有，别让调用方再算一遍。
 */
export type MemoBundle = {
  hasToken: boolean
  memo: MemoState | null
  loading: boolean
  confirming: boolean
  adding: boolean
  advancing: boolean
  notice: { ok: boolean; text: string } | null
  /** 变形族以哪个词为基准；墨墨不可用时为空串（不列变形） */
  base: string
  /** 加入学习计划（第一次调用只切成确认态） */
  add: () => Promise<void>
  /** 提前复习 */
  advance: () => Promise<void>
}

export function useMemoState(target: string): MemoBundle {
  const token = useSession((s) => s.token)

  /** null 表示还没拿到（或没连墨墨） */
  const [memo, setMemo] = useState<MemoState | null>(null)
  const [loading, setLoading] = useState(false)
  /** 加词要点两次：第一次只把按钮变成「确认加入」 */
  const [confirming, setConfirming] = useState(false)
  const [adding, setAdding] = useState(false)
  const [advancing, setAdvancing] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  // 释义先出，墨墨状态后补：网络慢不该挡住看释义
  useEffect(() => {
    if (!token) return
    let alive = true
    setMemo(null)
    setLoading(true)
    setConfirming(false)
    setNotice(null)

    void lookupMemoState(target).then((state) => {
      if (!alive) return
      setMemo(state)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [target, token])

  async function advance() {
    setAdvancing(true)
    setNotice(null)
    const res = await advanceWord(target)
    setAdvancing(false)
    setNotice({ ok: res.ok, text: res.message })

    if (res.ok) setMemo(await lookupMemoState(target))
  }

  async function add() {
    if (!confirming) {
      setConfirming(true)
      setNotice(null)
      return
    }

    setAdding(true)
    const res = await addToPlan(target)
    setAdding(false)
    setConfirming(false)
    setNotice({ ok: res.ok, text: res.message })

    if (res.ok) setMemo(await lookupMemoState(target))
  }

  // 短语没有"变形家族"，只有单词才列；不可用的词也不列
  const base =
    memo?.kind === 'in-plan'
      ? memo.record.voc_spelling
      : memo?.kind === 'available'
        ? memo.spelling
        : ''

  return {
    hasToken: Boolean(token),
    memo,
    loading,
    confirming,
    adding,
    advancing,
    notice,
    base,
    add,
    advance,
  }
}
