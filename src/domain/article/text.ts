import { countWordsIn } from '@/lib/text'

import type { Article } from './model'

/**
 * 文章的文本导出：词数、可复制的纯文本。
 *
 * 从 `domain/article.ts` 拆出来的——这两件事是**纯展示格式化**，
 * 既不选词也不调模型，却被绑在同一个文件里跟着 `store/llm` 一起走。
 */

export function wordCount(article: Pick<Article, 'sentences'>): number {
  return countWordsIn(article.sentences)
}

/**
 * 把文章拼成可复制的纯文本。
 *
 * - 始终带标题；打开译文时连中文标题一起带
 * - 未打开译文：正文按段落连排，段间空行
 * - 打开译文：逐句「一句原文、一句译文」，句间换行而不是连排——
 *   连排会把中英混成一大坨，粘贴到笔记里没法看
 *
 * perPara 由界面传进来（阅读页按固定句数切段），这里不掺显示逻辑。
 */
export function articleToText(
  article: Pick<Article, 'title' | 'titleZh' | 'sentences'>,
  opts: { withZh: boolean; perPara: number },
): string {
  const head = [article.title]
  if (opts.withZh && article.titleZh) head.push(article.titleZh)

  const perPara = Math.max(1, opts.perPara)
  const paras: string[] = []
  for (let i = 0; i < article.sentences.length; i += perPara) {
    const chunk = article.sentences.slice(i, i + perPara)
    const lines = chunk.map((s) =>
      opts.withZh && s.zh ? `${s.en}\n${s.zh}` : s.en,
    )
    paras.push(lines.join(opts.withZh ? '\n' : ' '))
  }

  return [head.join('\n'), ...paras].join('\n\n')
}
