import { useEffect, useRef, useState } from 'react'

import type { ReleaseInfo } from '@/domain/update'

import { useScrollLock } from '../hooks/useScrollLock'
import { useSheetHeight } from '../hooks/useSheetHeight'
import styles from './UpdateSheet.module.css'

type Props = {
  info: ReleaseInfo
  onClose: () => void
}

/**
 * 发现新版本的提示弹层。
 * 样式与动效与词卡弹层同一套（遮罩淡入 + 高度从底边撑开），更新日志原文滚动展示。
 */
export default function UpdateSheet({ info, onClose }: Props) {
  const [closing, setClosing] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const height = useSheetHeight(shellRef, contentRef, !closing)

  // 与词卡同一个问题：遮罩挂在 .body 里，弹层开着时滑动会带着背景滚
  useScrollLock(true)

  // 关闭时先播出场动画，播完再真正卸载（与 CSS 的 0.26s 高度过渡对齐）
  function requestClose() {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, 260)
  }

  useEffect(() => {
    if (!closing) return
    return () => setClosing(false)
  }, [closing])

  return (
    <div className={styles.mask} data-closing={closing} onClick={requestClose} role="presentation">
      <div
        className={styles.sheet}
        ref={shellRef}
        style={{ height }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="发现新版本"
      >
        <div className={styles.inner} ref={contentRef}>
          <div className={styles.handle} />
          <div className={styles.head}>
            <span className={styles.title}>发现新版本 {info.version}</span>
            <button type="button" className={styles.close} onClick={requestClose} aria-label="关闭">
              关闭
            </button>
          </div>
          {info.name && info.name !== info.version && (
            <p className={styles.releaseName}>{info.name}</p>
          )}

          {info.notes ? (
            <div className={styles.notes} data-testid="update-notes">
              {info.notes}
            </div>
          ) : (
            <p className={styles.noNotes}>这个版本没有附更新日志。</p>
          )}

          <div className={styles.actions}>
            <a
              type="button"
              className={styles.primary}
              href={info.url}
              target="_blank"
              rel="noreferrer"
            >
              前往发布页下载
            </a>
            <button type="button" className={styles.ghost} onClick={requestClose}>
              下次再说
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
