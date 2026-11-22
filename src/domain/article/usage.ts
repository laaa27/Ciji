import { articlesOfDay, saveArticle } from '@/data/article'

/**
 * 「今天已经用过的词」这条业务口径。
 *
 * 原先住在 `data/article.ts` 里，与文件读写混在一起 —— 违反手册 2.2「data 不放业务判断」，
 * 改「什么算已用」要去动存储层的文件。规则本身只有两条：
 * 1. 某天所有文章的目标词都算已用（忽略大小写）；
 * 2. 被用户点过「清除当天已用记录」的文章（`skipCoverage`）不算。
 *
 * 生成页靠它决定默认不勾哪些词；生成页的「清除」按钮靠它改这些标记。
 * 方向是 domain → data（手册 2.2 允许），所以读文件仍走 `data/article`，不自己碰存储。
 */

/** 这一天的文章覆盖了哪些词 */
export async function getCoveredWordsToday(date: string): Promise<Set<string>> {
  const covered = new Set<string>()
  for (const a of await articlesOfDay(date)) {
    // 用户点过「清除当天已用记录」的文章不算覆盖，那些词恢复默认可选
    if (a.skipCoverage) continue
    for (const w of a.targetWords) covered.add(w.toLowerCase())
  }
  return covered
}

/**
 * 把某天所有文章标记为「不计入已用」（生成页「清除当天已用记录」按钮）。
 * 文章本身保留，可继续阅读；返回实际标记了几篇。
 */
export async function markDayCoverageSkipped(date: string): Promise<number> {
  let marked = 0
  for (const a of await articlesOfDay(date)) {
    if (a.skipCoverage) continue
    await saveArticle({ ...a, skipCoverage: true })
    marked += 1
  }
  return marked
}
