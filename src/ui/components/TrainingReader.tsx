import {
  alignParaZh,
  BLANK_RE,
  cleanParaZh,
  type TrainingPassage,
  type TrainingQuestion,
} from '@/domain/training'
import { tokenize } from '@/lib/text'

import styles from './TrainingDoc.module.css'

/** 一段文字切成「普通文字 / 填空位」两种片段 */
type Chunk = { kind: 'text'; text: string } | { kind: 'blank'; no: number }

function splitBlanks(text: string): Chunk[] {
  const out: Chunk[] = []
  let last = 0
  const re = new RegExp(BLANK_RE.source, 'g')
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    out.push({ kind: 'blank', no: Number(m[1]) })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

type Props = {
  passage: TrainingPassage
  questions: TrainingQuestion[]
  showZh: boolean
  answers: Record<number, string>
  submitted: boolean
  /** 选词填空：当前选中的空位 */
  activeBlank: number | null
  /** 手动高亮的实例键集合（键规则见 TrainingDoc） */
  markSet: Set<string>
  /** 选词填空：字母 → 单词。卷面上显示词，不显示字母 */
  wordOf: (key?: string) => string | undefined
  /** 新题型空位回填的内容：七选五/观点概括回填字母、小标题回填标题文本 */
  blankDisplay?: (no: number) => string | undefined
  /** 回填的是小标题 —— 空位盒子按标题样式渲染（长文本换行） */
  blankIsHeading?: boolean
  /** 点空位：已填则清空，未填则选中 */
  onBlank: (no: number) => void
  /** 点词：实例键（段-句-片段-词序号）+ 该片段的分词结果 + 词位 */
  onWordTap: (key: string, parts: { text: string; isWord: boolean }[], j: number) => void
}

/** 文章正文：逐段逐句分词、可点词查词、完形填空的空位做进句子里、译文逐句混排 */
export function TrainingReader({
  passage,
  questions,
  showZh,
  answers,
  submitted,
  activeBlank,
  markSet,
  wordOf,
  blankDisplay,
  blankIsHeading,
  onBlank,
  onWordTap,
}: Props) {
  return (
    <article className={styles.body}>
      {passage.paras.map((para, pi) => {
        // 逐句对齐成功就一句原文一句译文；对不上（翻译拆并了句子）退回整段译文
        const aligned = showZh ? alignParaZh(para) : null
        return (
          <div key={pi} className={styles.paraWrap}>
            <p className={`${styles.para} ${styles.en}`}>
              {para.sents.map((s, si) => (
                <span key={si} data-sentence="true">
                  {s.label && <span className={styles.paraLabel}>{s.label}</span>}
                  {splitBlanks(s.en).map((chunk, ci) => {
                    if (chunk.kind === 'blank') {
                      return (
                        <Blank
                          key={`b${ci}`}
                          no={chunk.no}
                          chosen={answers[chunk.no]}
                          word={wordOf(answers[chunk.no])}
                          display={blankDisplay?.(chunk.no)}
                          heading={blankIsHeading}
                          answer={questions.find((x) => x.no === chunk.no)?.answer}
                          submitted={submitted}
                          active={activeBlank === chunk.no}
                          onClick={() => onBlank(chunk.no)}
                        />
                      )
                    }
                    // 接住分词结果：点词时把整段上下文交给短语匹配
                    const toks = tokenize(chunk.text)
                    return toks.map((part, j) =>
                      part.isWord ? (
                        <span key={`${ci}-${j}`} className={styles.glue}>
                          <button
                            type="button"
                            className={styles.word}
                            data-mark={
                              markSet.has(`${pi}-${si}-${ci}-${j}`) ? 'true' : undefined
                            }
                            onClick={() => {
                              onWordTap(`${pi}-${si}-${ci}-${j}`, toks, j)
                            }}
                          >
                            {part.text}
                          </button>
                          {part.tail}
                        </span>
                      ) : (
                        <span key={`${ci}-${j}`}>{part.text}</span>
                      ),
                    )
                  })}
                  {aligned?.[si] && <span className={styles.zh}>{aligned[si]}</span>}{' '}
                </span>
              ))}
            </p>
            {showZh && para.zh && !aligned && (
              <p className={styles.paraZh}>{cleanParaZh(para.zh)}</p>
            )}
          </div>
        )
      })}
    </article>
  )
}

function Blank({
  no,
  chosen,
  word,
  display,
  heading,
  answer,
  submitted,
  active,
  onClick,
}: {
  no: number
  chosen?: string
  /** 已选词的原文 —— 卷面上一段话中间写个字母很别扭，写词才读得下去 */
  word?: string
  /** 新题型空位回填的内容：字母或小标题文本；空位未答时不传 */
  display?: string
  /** display 是小标题文本 —— 按标题样式渲染 */
  heading?: boolean
  answer?: string
  submitted: boolean
  active: boolean
  onClick: () => void
}) {
  const right = submitted && chosen && chosen === answer
  const wrong = submitted && chosen && chosen !== answer
  const shown = display ?? word ?? no
  return (
    <button
      type="button"
      className={styles.blank}
      data-filled={chosen ? 'true' : 'false'}
      data-active={active ? 'true' : 'false'}
      data-heading={heading && display ? 'true' : undefined}
      data-right={right ? 'true' : wrong ? 'false' : undefined}
      onClick={onClick}
    >
      {shown}
    </button>
  )
}
