import { useEffect, useRef, useState } from 'react'

import type { PhraseHit } from '@/domain/phrase'
import { inflectionFamily } from '@/domain/wordforms'
import { useGlossSource } from '../hooks/useGlossSource'
import { useMemoState } from '../hooks/useMemoState'
import { useScrollLock } from '../hooks/useScrollLock'
import { useSheetHeight } from '../hooks/useSheetHeight'
import GlossPanel from './wordcard/GlossPanel'
import MemoPanel from './wordcard/MemoPanel'
import styles from './WordSheet.module.css'

type Props = {
  word: string
  /**
   * 点词时在上下文里匹配到的固定搭配。
   * 有值就先展示短语（聊天式地补上来，不打断已经显示的单词释义），
   * 用户随时能切回单词——因为"我其实只想查这个词"完全合理。
   */
  phrase?: PhraseHit | null
  /** 打开高亮：按下把当前词标进正文 */
  onHighlight?: () => void
  /** 这个词现在是否已高亮 */
  marked?: boolean
  onClose: () => void
  /** 点变形小标签：换成那个词重新查 */
  onPick: (word: string) => void
}

/**
 * 点词弹层（外壳）。
 *
 * 只负责四件事：遮罩与出场/收起动画、短语↔单词切换、高亮入口、变形小标签。
 * 三块「住在词卡里但与外壳无关」的内容各自独立：
 * - 释义与备选：`useGlossSource` + `wordcard/GlossPanel`
 * - 墨墨状态与两个写操作：`useMemoState` + `wordcard/MemoPanel`
 * - 变形族：本文件按基准词喂 `inflectionFamily`（输入只有 base + 主释义）
 */
export default function WordSheet({ word, phrase, onHighlight, marked, onClose, onPick }: Props) {
  // 弹层开着时，背景里的文章不该还能被手指带着滚（见 hook 注释）
  useScrollLock(true)

  /** 短语 / 单词：匹配到短语时默认看短语，但可以一键切回来 */
  const [view, setView] = useState<'phrase' | 'word'>(phrase ? 'phrase' : 'word')
  const target = view === 'phrase' && phrase ? phrase.text : word

  /** 主释义 + 备选释义（AI / 自定义）全在这个 hook 里，见 useGlossSource */
  const source = useGlossSource(target)

  const custom = source.alt.custom
  const altAi = source.alt.ai
  /**
   * 主释义查不到时用自定义释义兜底：这类词点开本来是空白，
   * 而用户明明已经给它写过释义，没有理由不显示。
   */
  const usingCustomAsMain = !source.gloss && Boolean(custom)
  const mainText = source.gloss ?? (usingCustomAsMain ? (custom ?? null) : null)
  const mainTag = usingCustomAsMain ? '自定义' : source.ai ? 'AI 释义' : ''
  /** 自定义已有内容且与主释义不同，才单独占一行（相同就没必要读两遍） */
  const customRow = custom && custom !== mainText ? custom : ''

  /** 关闭时先播出场动画，播完再真正卸载 */
  const [closing, setClosing] = useState(false)
  /** 高度动画的两个节点：壳子负责 height，内容负责被量（见 useSheetHeight） */
  const shellRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const height = useSheetHeight(shellRef, contentRef, !closing)

  /** 墨墨状态 + 加词 / 提前复习（带额度代价，状态都在 hook 里） */
  const memos = useMemoState(target)
  /** 同族变形（原形 + 本地词典里真实存在的其他形式） */
  const [forms, setForms] = useState<string[]>([])

  useEffect(() => {
    setView(phrase ? 'phrase' : 'word')
  }, [phrase, word])

  function requestClose() {
    if (closing) return
    setClosing(true)
    // 与 CSS 的高度过渡同一时长（0.26s）：早了会截断收起动画，晚了弹层已经归零还挂着
    setTimeout(onClose, 260)
  }

  // 变形标签：定位到原形之后再算，纯本地，不发请求。
  // 短语、以及墨墨不可用（`base` 为空）时不列。
  useEffect(() => {
    if (view === 'phrase' || !memos.base) {
      setForms([])
      return
    }

    let alive = true
    void inflectionFamily(memos.base, mainText, [target]).then((list) => {
      if (alive) setForms(list)
    })
    return () => {
      alive = false
    }
  }, [memos.base, mainText, view, target])

  return (
    <div className={styles.mask} data-closing={closing} onClick={requestClose} role="presentation">
      <div
        className={styles.sheet}
        ref={shellRef}
        style={{ height }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${target} 的释义`}
      >
        <div className={styles.inner} ref={contentRef}>
          <div className={styles.handle} />
          <div className={styles.head}>
            <span className={styles.word}>{target}</span>
            {onHighlight && (
              <button
                type="button"
                className={styles.mark}
                data-on={marked ? 'true' : 'false'}
                onClick={onHighlight}
              >
                {marked ? '取消高亮' : '高亮'}
              </button>
            )}
            <button type="button" className={styles.close} onClick={requestClose} aria-label="关闭">
              关闭
            </button>
          </div>
          {phrase && (
            <div className={styles.views}>
              <button
                type="button"
                className={styles.viewChip}
                data-on={view === 'phrase'}
                onClick={() => setView('phrase')}
              >
                短语
              </button>
              <button
                type="button"
                className={styles.viewChip}
                data-on={view === 'word'}
                onClick={() => setView('word')}
              >
                {word}
              </button>
            </div>
          )}

          <GlossPanel
            word={target}
            source={source}
            mainText={mainText}
            mainTag={mainTag}
            customRow={customRow}
            altAi={altAi}
            custom={custom}
          />

          {view === 'word' && forms.length > 1 && (
            <div className={styles.forms}>
              {forms.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={styles.form}
                  data-on={f === word.toLowerCase()}
                  onClick={() => onPick(f)}
                >
                  {f}
                </button>
              ))}
            </div>
          )}

          <MemoPanel word={target} memos={memos} />
        </div>
      </div>
    </div>
  )
}
