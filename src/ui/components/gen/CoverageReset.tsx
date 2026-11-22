import { useState } from 'react'

import { markDayCoverageSkipped } from '@/data/article'

import styles from '../GenerateArticle.module.css'

/**
 * 「清除当天已生成文章的记录」——两次确认 + 结果提示。
 *
 * 这是**改磁盘上其他文章**的数据维护操作，和选词不是一件事：它成功之后要
 * 让父层重读那天的已用词（父层用 `onDone` 触发）。原先挤在生成页里，
 * 三个 state（确认态 / 提示 / 重读计数）占了选词状态机的位置。
 */
export default function CoverageReset({
  date,
  disabled,
  onDone,
}: {
  /** 要清哪一天 */
  date: string
  /** 数据还没读出来时不允许点 */
  disabled?: boolean
  /** 清完（无论成败）后通知父层重读 */
  onDone: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function handleClear() {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    try {
      const n = await markDayCoverageSkipped(date)
      setMsg(n > 0 ? `已清除 ${n} 篇文章的已用标记，单词恢复可选` : '今天还没有需要清除的记录')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '清除失败，请重试')
    }
    onDone()
  }

  return (
    <div className={styles.clearRow}>
      <button
        type="button"
        className={confirming ? styles.clearBtn : styles.clearBtnGhost}
        onClick={() => void handleClear()}
        disabled={disabled}
      >
        {confirming ? '确认清除？（单词会恢复默认可选）' : '清除今天已生成文章的记录'}
      </button>
      {msg && <p className={styles.hint}>{msg}</p>}
    </div>
  )
}
