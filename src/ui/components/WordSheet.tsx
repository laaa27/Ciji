import { useEffect, useState } from 'react'

import { lookupOne } from '@/data/dict'
import styles from './WordSheet.module.css'

type Props = {
  word: string
  onClose: () => void
}

export default function WordSheet({ word, onClose }: Props) {
  const [gloss, setGloss] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** 关闭时先播出场动画，播完再真正卸载 */
  const [closing, setClosing] = useState(false)

  function requestClose() {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, 180)
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    setGloss(null)
    void lookupOne(word).then((g) => {
      if (!alive) return
      setGloss(g)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [word])

  return (
    <div className={styles.mask} data-closing={closing} onClick={requestClose} role="presentation">
      <div
        className={styles.sheet}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${word} 的释义`}
      >
        <div className={styles.handle} />
        <div className={styles.head}>
          <span className={styles.word}>{word}</span>
          <button type="button" className={styles.close} onClick={requestClose} aria-label="关闭">
            关闭
          </button>
        </div>
        <p className={styles.gloss}>
          {loading ? '查询中…' : gloss || '没有查到这个词的释义'}
        </p>
      </div>
    </div>
  )
}
