import { post } from './client'
import type { QueryVocabularyResponse } from './types'

const P = '/api/v1/memo/vocabulary'

/**
 * 按拼写批量查墨墨词库（最多 1000）。
 *
 * 用途只有一个：把拼写换成 id —— `add_words` 只认 id。
 * 返回里没有释义，释义仍然走本地 ECDICT。
 */
export function queryVocabulary(spellings: string[]) {
  // 纯查询，重试安全
  return post<QueryVocabularyResponse>(`${P}/query`, { spellings }, undefined, 1)
}
