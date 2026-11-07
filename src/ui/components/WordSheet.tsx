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
    <div className={styles.mask} onClick={onClose} role="presentation">
      <div
        className={styles.sheet}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${word} 的释义`}
      >
        <div className={styles.handle} />
        <div className={styles.head}>
          <span className={styles.word}>{word}</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="关闭">
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
