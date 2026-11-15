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

export type Token = {
  text: string
  /** 紧跟在词后、中间没有空格的标点（`shop.` 的那个句点） */
  tail: string
  isWord: boolean
}

/**
 * 按单词切分句子，保留标点和空格。
 *
 * `tail` 要跟单词一起渲染成一个不可断的整体 —— 否则浏览器会在 button（inline-block）
 * 和标点之间断行，句号就孤零零掉到下一行去。
 *
 * 阅读页与训练页共用这一份：切词口径不一致的话，同一个词在两边可能一个能点、一个点不到。
 */
export function tokenize(sentence: string): Token[] {
  const parts: Token[] = []
  const re = wordPattern()
  let last = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(sentence)) !== null) {
    if (m.index > last) parts.push({ text: sentence.slice(last, m.index), tail: '', isWord: false })

    let end = m.index + m[0].length
    // 只吃「非空白」的尾巴：逗号后的空格必须留在外面，不然下一句会和这个词粘死
    const glued = /^[^\sA-Za-z]+/.exec(sentence.slice(end))
    const tail = glued ? glued[0] : ''
    end += tail.length

    parts.push({ text: m[0], tail, isWord: true })
    last = end
  }
  if (last < sentence.length) parts.push({ text: sentence.slice(last), tail: '', isWord: false })

  return parts
}
