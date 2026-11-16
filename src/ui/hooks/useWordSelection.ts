import { useEffect, useRef, useState } from 'react'

import { lookupKnownPhrases } from '@/domain/memo'
import { findPhraseAround, phraseCandidates, phraseVariants, type PhraseHit } from '@/domain/phrase'
import { pushBackHandler } from '@/store/backstack'
import { useSession } from '@/store/session'

/**
 * 点词弹层的共享控制器：阅读页与做题页必须同一套。
 *
 * 两段式查词（本地短语快路径 → 墨墨慢路径）+ `phraseFor` 防串 +
 * 弹层开着时返回键先关弹层。以前只有阅读页有完整版，做题页只接了单词
 * —— 收进 hook 之后两页不许再分叉。
 *
 * 高亮不在本 hook 里：标记绑定「点中的位置」，实例键由各页面自己定
 * （阅读页无空位、做题页有空位切片），hook 只负责「查什么词」。
 */
export function useWordSelection() {
  const [word, setWord] = useState<string | null>(null)
  /** 点词后在上下文里匹配到的固定搭配；到货后弹层会自动切到短语视图 */
  const [phrase, setPhrase] = useState<PhraseHit | null>(null)
  /** 防止上一次匹配的结果盖到刚点的另一个词上 */
  const phraseFor = useRef('')

  const open = (parts: { text: string; isWord: boolean }[], j: number) => {
    const target = parts[j].text
    phraseFor.current = target
    setPhrase(null)
    setWord(target)

    void (async () => {
      // 快路径：本地词典命中就不用发请求
      const local = await findPhraseAround(parts, j)
      if (phraseFor.current !== target) return
      if (local) {
        setPhrase(local)
        return
      }

      // 慢路径：本地没有就问墨墨（实测同样是 20 个高频搭配，本地命中 7 个、墨墨 14 个）
      // 查询串做逐词还原：墨墨收录的是原形（rest on），文章里是变形（rests on）；
      // 变体表同时记住「哪个变体属于哪个窗口」，命中后弹层显示还原出的原形
      if (!useSession.getState().token) return
      const cands = phraseCandidates(parts, j)
      if (cands.length === 0) return

      const variantOf = new Map<string, (typeof cands)[number]>()
      for (const cand of cands) {
        for (const v of phraseVariants(cand.words)) {
          if (!variantOf.has(v)) variantOf.set(v, cand)
        }
      }

      const known = await lookupKnownPhrases([...variantOf.keys()])
      if (phraseFor.current !== target) return
      // 候选本来就是最长优先；命中时把弹层文本换成命中的那个原形变体
      const hit = cands
        .map((cand) => {
          const matched = phraseVariants(cand.words).find((v) => known.has(v))
          return matched ? { ...cand, text: matched } : null
        })
        .find(Boolean)
      if (hit) setPhrase(hit)
    })()
  }

  /** 点变形小标签：换成那个词重新查；短语匹配的归属也跟着换 */
  const pick = (next: string) => {
    phraseFor.current = next
    setPhrase(null)
    setWord(next)
  }

  const close = () => {
    phraseFor.current = ''
    setPhrase(null)
    setWord(null)
  }

  // 词卡是弹层不是二级视图（没有返回动画），返回键单独注册
  useEffect(() => {
    if (!word) return
    return pushBackHandler(close)
  }, [word])

  return { word, phrase, open, pick, close }
}
