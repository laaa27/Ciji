/**
 * 偏好类存储键的唯一出处。
 *
 * 只收「跟设置/界面偏好有关」的键。data 层那几个带命名空间的集合
 * （`day:` / `article:` / `gloss:`）仍定义在各自模块里——它们是批量读写的数据集合，
 * 和这里的单值偏好不是一类东西，硬塞进来反而要额外解释。
 *
 * 键名一律保持历史值，不做重命名：改键 = 已装机用户的设置被重置。
 */

export const PREF_KEYS = {
  /** 阅读页正文字号 */
  readingFont: 'reading_font_size',
  /** 一篇文章最多覆盖多少个目标词 */
  readingLimit: 'reading_word_limit',
  /** 默认生成难度 */
  readingLevel: 'reading_level',
  /** 今日页释义是否展开 */
  glossToday: 'today_show_gloss',
  /** 历史页释义是否展开 */
  glossHistory: 'history_show_gloss',
} as const
