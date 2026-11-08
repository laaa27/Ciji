import { post } from './client'
import type {
  AddWordsResponse,
  AdvanceStudyResponse,
  ProgressResponse,
  QueryRecordsRequest,
  QueryRecordsResponse,
  TodayItemsRequest,
  TodayItemsResponse,
} from './types'

const P = '/api/v1/memo/study'

/** 今日学习进度与时长。可传入临时 token 用于「先测试再保存」 */
export function getStudyProgress(token?: string) {
  return post<ProgressResponse>(`${P}/get_study_progress`, {}, token)
}

/** 今日学习单词。limit 上限 1000，默认只给 50，必须显式传大 */
export function getTodayItems(req: TodayItemsRequest = {}) {
  return post<TodayItemsResponse>(`${P}/get_today_items`, {
    voc_ids: [],
    spellings: [],
    limit: 1000,
    ...req,
  })
}

/** 学习记录，可按 voc_ids 批量精确查询 */
export function queryStudyRecords(req: QueryRecordsRequest = {}) {
  return post<QueryRecordsResponse>(`${P}/query_study_records`, {
    limit: 1000,
    ...req,
  })
}

/**
 * 把单词加入学习计划。
 *
 * 返回的 added_count 是「请求数 / 剩余额度 / 去重后的新词数」三者里最小的那个，
 * 官方文档明确说额度不足和已加入都会让它变小 —— 所以不能靠它区分原因，
 * 调用前先查学习记录（见 domain/memo.ts）。
 */
export function addWords(ids: string[], advance = false) {
  return post<AddWordsResponse>(`${P}/add_words`, {
    words: ids.map((id) => ({ id })),
    advance,
  })
}

/**
 * 把已加入计划的词提前到当下复习。
 *
 * 官方文档：需要升级到 10 级解锁提前复习功能；返回的 advanced_count
 * 会因「没加入计划」「等级不够」而变小。
 */
export function advanceStudy(ids: string[]) {
  return post<AdvanceStudyResponse>(`${P}/advance_study`, { voc_ids: ids })
}
