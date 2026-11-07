import { getStudyProgress, getTodayItems, queryStudyRecords } from '@/api/study'
import type { StudyResponse } from '@/api/types'

import { dateKey } from '@/lib/date'

export type WordState = 'new' | 'vague' | 'forget'

export interface CollectedWord {
  vocId: string
  spelling: string
  state: WordState
  isNew: boolean
  firstResponse?: StudyResponse
  /** 当天最后一次反馈，仅当能查到记录时存在 */
  lastResponse?: StudyResponse
  isFinished: boolean
  order: number
}

export interface TodaySnapshot {
  /** YYYY-MM-DD（北京时间） */
  date: string
  finished: number
  total: number
  studyTimeMs: number
  words: CollectedWord[]
  collectedAt: string
  /** 接口返回不完整时的说明，界面据此提示而不是假装正常 */
  warning?: string
}

/** 中文短语，用于界面上的「初模糊 → 终认识」 */
export const RESPONSE_LABEL: Record<StudyResponse, string> = {
  FAMILIAR: '认识',
  VAGUE: '模糊',
  FORGET: '忘记',
  WELL_FAMILIAR: '熟知',
  CANCEL_WELL_FAMILIAR: '取消熟知',
}

/**
 * 判断一个词今天是否真的学过。
 * get_today_items 会返回「今天安排了但还没学」的词，必须排除。
 * 注意不能只看 is_finished —— 学到一半退出时 first_response 已有值但未完成。
 */
function wasStudied(item: {
  first_response?: StudyResponse
  is_finished: boolean
}): boolean {
  return item.is_finished || Boolean(item.first_response)
}

/**
 * 归入哪一组。三组互斥，优先级 忘记 > 模糊 > 新学，
 * 保证三组数量之和等于今天真正学过的词数。
 */
function classify(item: {
  is_new: boolean
  first_response?: StudyResponse
}): WordState | null {
  if (item.first_response === 'FORGET') return 'forget'
  if (item.first_response === 'VAGUE') return 'vague'
  if (item.is_new) return 'new'
  return null
}

/** 拉取今天的完整快照：进度 + 词表 + 每个词的末次反馈 */
export async function collectToday(): Promise<TodaySnapshot> {
  const [progressRes, todayRes] = await Promise.all([
    getStudyProgress().catch(() => null),
    getTodayItems({ limit: 1000 }),
  ])

  const rawItems = todayRes.today_items ?? []

  // 只对真正答过题的词查末次反馈，一次批量请求即可（上限 1000）
  const studied = rawItems.filter(wasStudied)
  const needLast = studied.filter((it) => it.first_response).map((it) => it.voc_id)

  const lastMap = new Map<string, StudyResponse>()
  if (needLast.length > 0) {
    try {
      const rec = await queryStudyRecords({ voc_ids: needLast.slice(0, 1000) })
      for (const r of rec.records ?? []) {
        if (r.last_response) lastMap.set(r.voc_id, r.last_response)
      }
    } catch {
      // 末次反馈是锦上添花，失败不影响主流程
    }
  }

  const words: CollectedWord[] = []
  for (const item of studied) {
    const state = classify(item)
    if (!state) continue
    const last = lastMap.get(item.voc_id)
    words.push({
      vocId: item.voc_id,
      spelling: item.voc_spelling,
      state,
      isNew: Boolean(item.is_new),
      firstResponse: item.first_response,
      lastResponse: last,
      isFinished: Boolean(item.is_finished),
      order: item.order ?? 0,
    })
  }

  words.sort((a, b) => a.order - b.order)

  // 接口是公测，且「当日未打开 App 初始化」时不保证有数据，必须显式降级
  const progress = progressRes?.progress
  const hasProgress = Boolean(progress) && typeof progress?.finished === 'number'

  let warning: string | undefined
  if (!hasProgress) {
    warning =
      rawItems.length > 0
        ? '进度数据缺失，下面的词表仍然可用'
        : '接口没有返回今日数据。确认墨墨 App 里已开启「自动同步」，并在今天打开过它。'
  }

  return {
    date: dateKey(),
    finished: hasProgress ? progress!.finished : studied.length,
    total: hasProgress ? progress!.total : 0,
    studyTimeMs: hasProgress ? progress!.study_time : 0,
    words,
    collectedAt: new Date().toISOString(),
    warning,
  }
}

/** 「初模糊 → 终认识」；首末一致或无末次反馈时返回 undefined */
export function responseNote(word: CollectedWord): string | undefined {
  const { firstResponse, lastResponse } = word
  if (!firstResponse || !lastResponse) return undefined
  if (firstResponse === lastResponse) return undefined
  return `初${RESPONSE_LABEL[firstResponse]} → 终${RESPONSE_LABEL[lastResponse]}`
}
