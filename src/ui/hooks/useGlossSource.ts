import { useCallback, useEffect, useState } from 'react'

import { readGlossAlt, saveGlossAlt, type GlossAlt } from '@/data/gloss'
import { lookupOneDetailed, requestAiGloss } from '@/domain/lookup'
import { useLlm } from '@/store/llm'

/**
 * 词卡里的释义来源。
 *
 * 从 `WordSheet` 里搬出来的：那个组件原本就有 13 个 `useState`（规范 9.4 的红线），
 * 再往里塞"备选释义 / AI 请求中 / 编辑中"必然越线。释义这块自带完整生命周期
 * （按词重新查、按词存备选），单独一个 hook 最合适。
 *
 * 三件事固定：
 * 1. **主释义永远显示**（本地词典 → 缓存 → AI → MyMemory，与原链路一致）
 * 2. **AI 释义**：仅当主释义不是 AI 时才作为「备选」存在（否则会与主释义一字不差）；
 *    主释义是 AI 时，按钮变成「重新生成」，结果直接更新主释义
 * 3. **自定义释义**：永远优先于备选展示；主释义查不到时用它兜底（用户要求）
 */
export interface GlossSource {
  /** 主释义（可能为 null：这个词真的查不到） */
  gloss: string | null
  /** 主释义是否来自 AI —— 决定「AI 释义」按钮是"生成"还是"重新生成" */
  ai: boolean
  loading: boolean
  /** 备选释义 */
  alt: GlossAlt
  aiBusy: boolean
  /** AI 请求失败 / 没配模型时的提示 */
  aiNotice: string | null
  /** 有没有可用的释义模型（没有就把 AI 入口禁用） */
  hasModel: boolean
  /** 生成或重新生成 AI 释义 */
  requestAi: () => Promise<void>
  /** 保存自定义释义；传空串等于删除 */
  saveCustom: (text: string) => Promise<void>
  dropAi: () => Promise<void>
  dropCustom: () => Promise<void>
}

export function useGlossSource(word: string): GlossSource {
  const [gloss, setGloss] = useState<string | null>(null)
  const [ai, setAi] = useState(false)
  const [loading, setLoading] = useState(true)
  const [alt, setAlt] = useState<GlossAlt>({})
  const [aiBusy, setAiBusy] = useState(false)
  const [aiNotice, setAiNotice] = useState<string | null>(null)

  // 布尔值做选择器：直接返回 glossActive() 的对象会让 zustand 每次都比出新引用
  const hasModel = useLlm((s) => Boolean(s.glossActive()))

  useEffect(() => {
    let alive = true
    setLoading(true)
    setGloss(null)
    setAi(false)
    setAlt({})
    setAiNotice(null)

    void lookupOneDetailed(word, {
      // 本地/缓存命中先渲染：AI 释义要走网络，不该挡住瞬时查询
      onLocal: (g, fromAi) => {
        if (!alive) return
        setGloss(g)
        setAi(fromAi)
        setLoading(false)
      },
    }).then((res) => {
      if (!alive) return
      setGloss(res.gloss)
      setAi(res.ai)
      setLoading(false)
    })

    void readGlossAlt(word).then((next) => {
      if (alive) setAlt(next)
    })

    return () => {
      alive = false
    }
  }, [word])

  const requestAi = useCallback(async () => {
    if (aiBusy) return
    setAiBusy(true)
    setAiNotice(null)
    try {
      // 主释义本身就是 AI 的：这次是"重新生成"，不新增行
      const next = await requestAiGloss(word, { asMain: ai })
      if (!next) {
        setAiNotice(hasModel ? '模型没有返回内容，可以再试一次' : '还没有配置大模型，去设置里加一个')
        return
      }
      if (ai) setGloss(next)
      else setAlt(await readGlossAlt(word))
    } finally {
      setAiBusy(false)
    }
  }, [ai, aiBusy, hasModel, word])

  const saveCustom = useCallback(
    async (text: string) => {
      const custom = text.trim().slice(0, 200)
      await saveGlossAlt(word, { ...alt, custom: custom || undefined })
      setAlt(await readGlossAlt(word))
    },
    [alt, word],
  )

  const dropAi = useCallback(async () => {
    await saveGlossAlt(word, { ...alt, ai: undefined })
    setAlt(await readGlossAlt(word))
  }, [alt, word])

  const dropCustom = useCallback(async () => {
    await saveGlossAlt(word, { ...alt, custom: undefined })
    setAlt(await readGlossAlt(word))
  }, [alt, word])

  return {
    gloss,
    ai,
    loading,
    alt,
    aiBusy,
    aiNotice,
    hasModel,
    requestAi,
    saveCustom,
    dropAi,
    dropCustom,
  }
}
