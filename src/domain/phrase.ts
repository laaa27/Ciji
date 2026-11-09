import { dictHas, lemmaCandidates } from '@/data/dict'

/**
 * 点词时顺手找一下「这个位置属于哪个固定搭配」。
 *
 * 思路来自实际使用场景：用户点某个词，往往是因为**这一串**看不懂，
 * 而不是想单独查这个词（"in spite of" 里点 spite 是最自然的动作）。
 * 所以以被点的词为锚点，在左右各 5 个词内找最长的词典短语。
 *
 * 为什么不做全文预扫描：全文每 2~6 词开窗是 O(n×5) 次查表，虽然也能跑，
 * 但会命中大量用户根本没注意的短语，把每个词都变成"可点多词单元"，反而更难用。
 * 锚点方案只在用户真的动手时才查，且天然限定在用户关注的上下文里。
 *
 * 覆盖率是这套方案的天花板：本地词典 18.6 万条里只有 6.4 万条多词条目，
 * 常见搭配实测只覆盖约三分之一（in spite of / as a result 都不在里面）。
 * 所以调用方必须保留「查不到就走单词」的退路。
 */

export interface PhraseToken {
  text: string
  isWord: boolean
}

export interface PhraseHit {
  /** 归一化后的短语，如 "in spite of" */
  text: string
  /** 组成词，保持原样大小写，给弹层列出来 */
  words: string[]
  start: number
  end: number
}

/** 一个短语最多几个词（"as a matter of fact" 是 6 个） */
const MAX_SPAN = 6
/** 锚点左右各看几个词 */
const DEFAULT_WINDOW = 5

/**
 * 纯虚词组成的窗口不算短语。
 * 否则 "a of"、"in the" 这类会在词典里误命中，把普通句子切碎。
 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but',
  'be', 'is', 'are', 'was', 'were', 'been', 'being', 'am',
  'it', 'this', 'that', 'these', 'those', 'as', 'by', 'with', 'from', 'into',
  'not', 'no', 'do', 'does', 'did', 'has', 'have', 'had', 'will', 'would',
  'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'if', 'so', 'than',
])

const hasContentWord = (words: string[]) => words.some((w) => !FUNCTION_WORDS.has(w.toLowerCase()))

/**
 * 两个词之间是否只隔着空白。
 * 中间夹标点就说明不是同一个搭配（"a bunch, of" 不该拼成 "a bunch of"）。
 */
function wordsAreAdjacent(tokens: PhraseToken[], a: number, b: number): boolean {
  for (let k = a + 1; k < b; k += 1) {
    if (/\S/.test(tokens[k].text)) return false
  }
  return true
}

/**
 * 生成候选窗口：所有包含锚点词、长度 2~6 的词串，最长优先。
 *
 * 抽出来是因为有两条匹配路径：本地词典（快、离线）和墨墨词库（全但要走网络），
 * 两条路用的是同一批候选，只是判定方式不同。
 */
export function phraseCandidates(
  tokens: PhraseToken[],
  index: number,
  window = DEFAULT_WINDOW,
): { text: string; words: string[]; start: number; end: number }[] {
  if (!tokens[index]?.isWord) return []

  const wordPos: number[] = []
  tokens.forEach((t, i) => {
    if (t.isWord) wordPos.push(i)
  })

  const anchor = wordPos.indexOf(index)
  if (anchor < 0) return []

  const lo = Math.max(0, anchor - window)
  const hi = Math.min(wordPos.length - 1, anchor + window)
  const maxLen = Math.min(MAX_SPAN, hi - lo + 1)

  const out: { text: string; words: string[]; start: number; end: number }[] = []

  for (let len = maxLen; len >= 2; len -= 1) {
    const firstStart = Math.max(lo, anchor - len + 1)
    const lastStart = Math.min(anchor, hi - len + 1)

    for (let start = firstStart; start <= lastStart; start += 1) {
      const slice = wordPos.slice(start, start + len)

      let contiguous = true
      for (let k = 1; k < slice.length; k += 1) {
        if (!wordsAreAdjacent(tokens, slice[k - 1], slice[k])) {
          contiguous = false
          break
        }
      }
      if (!contiguous) continue

      const words = slice.map((pos) => tokens[pos].text)
      if (!hasContentWord(words)) continue

      out.push({
        text: words.join(' ').toLowerCase(),
        words,
        start: slice[0],
        end: slice[slice.length - 1],
      })
    }
  }

  return out
}

/**
 * 以 tokens[index] 为锚点，找包含它的最长**本地词典**短语。
 * 找不到返回 null —— 调用方据此退回"只查这个词"，或再去问墨墨。
 */
export async function findPhraseAround(
  tokens: PhraseToken[],
  index: number,
  window = DEFAULT_WINDOW,
): Promise<PhraseHit | null> {
  for (const cand of phraseCandidates(tokens, index, window)) {
    for (const text of phraseVariants(cand.words)) {
      if (await dictHas(text)) return { ...cand, text }
    }
  }
  return null
}

/**
 * 一个窗口最多尝试几个变体。
 * 组合是乘性爆炸的（每个词 2~4 个变体 × 窗口里 2~6 个词），
 * 不设上限的话一次点词能生成上百个查询串，既慢又把缓存塞满。
 * 实测真正命中的几乎都在「只还原一个词」这一层（rests on → rest on），
 * 两层往上命中概率断崖式下降，截断损失可忽略。
 */
export const MAX_VARIANTS = 8

/**
 * 把「文章里的变形」还原成「词库里的原形」。
 *
 * 词库和墨墨收录的都是原形（rest on），文章里出现的却常是变形（rests on）——
 * 单词查询早就靠 lemmaCandidates 解决了，这里把同一招套到短语上：
 * 对每个实词生成变形候选，按「改动越少越可信」的顺序组合：
 * 1. 字面原样（rests on）
 * 2. 只还原一个词（rest on / rests on 的其他单变体）
 * 3. 还原两个词（仅在前两层没满时才生成）
 *
 * 虚词（of/on/the…）不参与还原——它们没有变形，还原只会制造噪音。
 * 返回值已小写、去重，首位永远是字面原样。
 */
export function phraseVariants(words: string[], cap = MAX_VARIANTS): string[] {
  const lower = words.map((w) => w.toLowerCase())
  const out: string[] = [lower.join(' ')]

  // 每个词的候选形式（首位是原样；虚词只有原样）
  const perWord = lower.map((w) => (FUNCTION_WORDS.has(w) ? [w] : lemmaCandidates(w)))

  const push = (combo: string[]) => {
    const text = combo.join(' ')
    if (!out.includes(text)) out.push(text)
  }

  for (let i = 0; i < lower.length && out.length < cap; i += 1) {
    for (const v of perWord[i]) {
      if (v === lower[i]) continue
      const combo = [...lower]
      combo[i] = v
      push(combo)
      if (out.length >= cap) break
    }
  }

  for (let i = 0; i < lower.length && out.length < cap; i += 1) {
    for (let j = i + 1; j < lower.length && out.length < cap; j += 1) {
      for (const a of perWord[i]) {
        if (a === lower[i]) continue
        for (const b of perWord[j]) {
          if (b === lower[j]) continue
          const combo = [...lower]
          combo[i] = a
          combo[j] = b
          push(combo)
          if (out.length >= cap) break
        }
        if (out.length >= cap) break
      }
    }
  }

  return out
}
