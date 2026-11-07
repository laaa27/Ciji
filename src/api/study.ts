import { post } from './client'
import type {
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
