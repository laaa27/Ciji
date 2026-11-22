import { useMemo, useRef, useState, useEffect } from 'react'

import { getCoveredWordsToday } from '@/data/article'
import { getDay } from '@/data/store'
import {
  defaultSelection,
  trimSelection,
  wordCandidates,
  type WordCandidate,
  type WordKind,
} from '@/domain/article'
import type { TodaySnapshot } from '@/domain/collect'
import { readGenDraft, saveGenDraft } from '@/store/ui'

/**
 * 生成页的「选词」状态机：哪一天、哪些类型、哪些词被勾上。
 *
 * 从 `GenerateArticle` 里搬出来的，判据是这几件事共享同一个生命周期——
 * 换日期要重读快照与他天已用词、三个开关要联动重算勾选、勾选结果要进草稿。
 * 页面上真正需要的只是「读到了吗 / 选了哪些 / 超没超上限」。
 *
 * 与页面无关的两块（生成进度、清除已用记录）不在这里：
 * 前者是纯展示，后者是改磁盘上的其他文章，都不参与选词状态机。
 */

/**
 * 三类词固定的顺序：既是展示顺序（页面按它画类型按钮），也是超上限时的裁剪优先级。
 * 与 `domain/collect` 的互斥归组同源，别在页面里另排一套。
 */
export const WORD_KINDS: WordKind[] = ['forget', 'vague', 'new']

export type WordPicking = {
  date: string
  setDate: (next: string) => void
  snapshot: TodaySnapshot | null
  /** 这天已被其他文章用过的词（打开开关才显示） */
  usedWords: Set<string>
  loading: boolean
  kinds: WordKind[]
  toggleKind: (kind: WordKind) => void
  selected: Set<string>
  toggleWord: (c: WordCandidate) => void
  showUsed: boolean
  toggleUsed: () => void
  allCandidates: WordCandidate[]
  /** 当前展示的词（跟「包含已用」开关走） */
  visible: WordCandidate[]
  chosen: WordCandidate[]
  rest: WordCandidate[]
  overLimit: boolean
  /** 按「忘记 → 模糊 → 新学」的顺序裁到上限，返回要提交的词 */
  pick: () => string[]
  /** 外部改了磁盘数据（清除已用记录）后强制重读 */
  reload: () => void
}

export function useWordPicking({
  today,
  limit,
}: {
  today: string
  limit: number
}): WordPicking {
  // 上次的选词草稿：进程被系统回收后回来，不用重新挑一遍
  const [draft] = useState(readGenDraft)
  const restored = useRef(false)

  const [date, setDate] = useState(draft?.date ?? today)
  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null)
  const [usedWords, setUsedWords] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const [kinds, setKinds] = useState<WordKind[]>(() => {
    const saved = draft?.kinds.filter((k): k is WordKind => WORD_KINDS.includes(k as WordKind))
    return saved && saved.length > 0 ? saved : WORD_KINDS
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showUsed, setShowUsed] = useState(false)
  /** 清除已用记录后自增，触发下面那个 effect 重读 */
  const [tick, setTick] = useState(0)

  // 换日期：读那天的快照 + 那天已用过的词，然后按当前类型重算默认勾选
  useEffect(() => {
    let alive = true
    setLoading(true)

    void (async () => {
      const [snap, covered] = await Promise.all([getDay(date), getCoveredWordsToday(date)])
      if (!alive) return
      setSnapshot(snap)
      setUsedWords(covered)

      const cands = wordCandidates(snap, covered)
      const fallback = new Set(defaultSelection(cands, WORD_KINDS))

      // 第一次进来且有草稿：沿用草稿的勾选（只保留这天还在候选里的词）
      if (!restored.current && draft?.selected?.length) {
        const available = new Set(cands.map((c) => c.spelling.toLowerCase()))
        const kept = new Set(draft.selected.filter((s) => available.has(s)))
        if (kept.size > 0) {
          restored.current = true
          setSelected(kept)
          setShowUsed(false)
          setLoading(false)
          return
        }
      }

      restored.current = true
      setSelected(fallback)
      setShowUsed(false)
      setLoading(false)
    })()

    return () => {
      alive = false
    }
  }, [date, draft, tick])

  // 勾选/类型/日期一变就记一笔，被杀之后还能接着来
  useEffect(() => {
    if (loading) return
    saveGenDraft({ date, kinds, selected: [...selected] })
  }, [date, kinds, selected, loading])

  const allCandidates = useMemo(
    () => wordCandidates(snapshot, usedWords),
    [snapshot, usedWords],
  )

  // 类型变了：重算应该默认勾上/取消哪些（已用手动词保留）
  function toggleKind(kind: WordKind) {
    const nextKinds = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind]
    setKinds(nextKinds)

    setSelected((prev) => {
      const next = new Set(prev)
      for (const c of allCandidates) {
        const key = c.spelling.toLowerCase()
        const match = c.kinds.includes(kind)
        if (!match || c.used) continue
        if (nextKinds.includes(kind)) {
          // 刚勾上这个类型 → 补进选择
          next.add(key)
        } else if (!c.kinds.some((k) => nextKinds.includes(k))) {
          // 刚取消 → 只撤掉「不落在任何剩余类型里」的词。
          // 多重归属的词（比如既是忘记又是新学）只要还有别的类型勾着就保留——
          // 否则「只看忘记」会把既是忘记又是新学的词全删光，明明 22 个忘记词只剩 1 个
          next.delete(key)
        }
      }
      return next
    })
  }

  function toggleWord(c: WordCandidate) {
    const key = c.spelling.toLowerCase()
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleUsed() {
    const next = !showUsed
    setShowUsed(next)

    // 收起「已用」时，把它们从选择里摘掉，避免出现「看不见却被用上」
    if (!next) {
      setSelected((prev) => {
        const copy = new Set(prev)
        for (const c of allCandidates) {
          if (c.used) copy.delete(c.spelling.toLowerCase())
        }
        return copy
      })
    }
  }

  const visible = showUsed ? allCandidates : allCandidates.filter((c) => !c.used)
  const chosen = visible.filter((c) => selected.has(c.spelling.toLowerCase()))
  const rest = visible.filter((c) => !selected.has(c.spelling.toLowerCase()))

  return {
    date,
    setDate,
    snapshot,
    usedWords,
    loading,
    kinds,
    toggleKind,
    selected,
    toggleWord,
    showUsed,
    toggleUsed,
    allCandidates,
    visible,
    chosen,
    rest,
    overLimit: chosen.length > limit,
    pick: () => trimSelection(allCandidates, selected, limit),
    reload: () => setTick((t) => t + 1),
  }
}
