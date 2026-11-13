/**
 * 英文分词与词数统计。
 *
 * 这套正则原先在四个地方各写一遍：data/article 建索引时数词数、domain/article
 * 审计篇幅、domain/article 找最长句、ReadingPage 渲染时切词。改一处漏三处，
 * 统计口径就可能悄悄不一致。
 *
 * 规则：以字母开头，允许中间的连字符与撇号（well-known、don't）。
 * 这是「数词」和「切词」共用的口径，不追求语言学正确。
 *
 * 撇号必须同时认 ASCII 的 `'` 和排版用的 `’`（U+2019）：模型输出与人手输入的
 * 文章里弯撇号很常见，只认 ASCII 时 `pharaoh’s` 会被切成 `pharaoh` + `s`，
 * 词数凭空多算一个，点那个孤零零的 `s` 也查不到任何东西。
 */

const WORD_BODY = "[A-Za-z][A-Za-z'\u2019-]*"

/**
 * 新建一个带 g 的正则。
 *
 * 不导出共享实例：`exec` 会推进 `lastIndex`，多处复用同一个 g 正则会互相污染。
 * 只在 `match` / `replace` 里用的话可以直接用返回值。
 */
export const wordPattern = (): RegExp => new RegExp(WORD_BODY, 'g')

/** 这段英文有多少个词 */
export function countWords(text: string): number {
  return (text.match(wordPattern()) ?? []).length
}

/** 一组句子合计多少词 */
export function countWordsIn(sentences: { en: string }[]): number {
  let total = 0
  for (const s of sentences) total += countWords(s.en)
  return total
}
