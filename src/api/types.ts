/**
 * 墨墨开放 API 的类型定义 —— 全项目唯一来源。
 *
 * 该接口处于「公测」状态，字段可能随时调整。
 * 因此除主键外一律声明为可选，读取时按缺失降级处理。
 */

/** 学习反馈：认识 / 模糊 / 忘记 / 熟知 / 取消熟知 */
export type StudyResponse =
  | 'FAMILIAR'
  | 'VAGUE'
  | 'FORGET'
  | 'WELL_FAMILIAR'
  | 'CANCEL_WELL_FAMILIAR'

/** 请求成功时的原始返回，按需裁剪 */
export interface StudyProgress {
  finished: number
  total: number
  /** 毫秒 */
  study_time: number
}

/** 今日学习列表中的一条 */
export interface TodayItem {
  voc_id: string
  voc_spelling: string
  /** 学习顺序 */
  order?: number
  /** 当天第一次反馈 */
  first_response?: StudyResponse
  is_new: boolean
  is_finished: boolean
}

/** 学习记录（长期计划维度） */
export interface StudyRecord {
  voc_id: string
  voc_spelling: string
  add_date?: string
  first_study_date?: string
  last_study_date?: string
  next_study_date?: string
  /** 最近一次反馈 */
  last_response?: StudyResponse
  study_count: number
  tags?: 'STICKING' | 'WELL_FAMILIAR' | ''
}

/** 词库里的一个词：只有 id 与拼写，没有释义 */
export interface Vocabulary {
  id: string
  spelling: string
}

/* ── 请求体 ───────────────────────────────── */

export interface TodayItemsRequest {
  is_finished?: boolean
  is_new?: boolean
  voc_ids?: string[]
  spellings?: string[]
  limit?: number
}

export interface QueryRecordsRequest {
  next_study_date?: { start?: string; end?: string }
  voc_ids?: string[]
  spellings?: string[]
  tags?: string
  as_count?: boolean
  limit?: number
}

/* ── 响应体 ───────────────────────────────── */

export interface ProgressResponse {
  progress: StudyProgress
}

export interface TodayItemsResponse {
  today_items: TodayItem[]
}

export interface QueryRecordsResponse {
  records: StudyRecord[]
  count: number
}

export interface QueryVocabularyResponse {
  voc: Vocabulary[]
}

export interface AdvanceStudyResponse {
  /** 成功提前的数量；未加入计划或等级不足会小于请求数 */
  advanced_count: number
}

export interface AddWordsResponse {
  /** 成功添加的数量；额度不足或已在计划里会少于此数 */
  added_count: number
}
