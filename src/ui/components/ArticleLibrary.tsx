import { useMemo, useState } from 'react'

import type { ArticleMeta } from '@/data/article'
import { clockTime, monthDay, weekday } from '@/lib/date'

import styles from './ArticleLibrary.module.css'

/**
 * 文章库：按日期分组、时间倒序，可打开、可删除。
 *
 * 做成阅读页里的一个子视图（不是新开 Tab），因为它是「阅读」的下级，
 * 而且这样返回时能原样回到刚才读到的地方。
 */

type Props = {
  items: ArticleMeta[]
  currentId?: string
  onBack: () => void
  onOpen: (id: string) => void
  onDelete: (id: string) => Promise<void> | void
}

export default function ArticleLibrary({ items, currentId, onBack, onOpen, onDelete }: Props) {
  /** 删除要点两次：第一次只把按钮变成「确认」，避免误删 */
  const [confirmId, setConfirmId] = useState<string | null>(null)

  // items 已经是倒序，这里只按日期切段，保持原顺序
  const groups = useMemo(() => {
    const map = new Map<string, ArticleMeta[]>()
    for (const item of items) {
      const bucket = map.get(item.date)
      if (bucket) bucket.push(item)
      else map.set(item.date, [item])
    }
    return [...map.entries()]
  }, [items])

  async function handleDelete(id: string) {
    if (confirmId !== id) {
      setConfirmId(id)
      return
    }
    setConfirmId(null)
    await onDelete(id)
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.back} onClick={onBack}>
          <span aria-hidden="true">‹</span> 返回
        </button>
        <h1 className={styles.title}>文章库</h1>
        <span className={styles.count}>{items.length} 篇</span>
      </header>

      {items.length === 0 && (
        <p className={styles.empty}>还没有生成过文章。回到阅读页，选好词就能生成第一篇。</p>
      )}

      {groups.map(([date, list]) => (
        <section key={date} className={styles.group}>
          <h2 className={styles.date}>
            {monthDay(date)}
            <span className={styles.weekday}>{weekday(date)}</span>
          </h2>

          <ul>
            {list.map((item) => (
              <li key={item.id} className={styles.row} data-current={item.id === currentId}>
                <button
                  type="button"
                  className={styles.open}
                  onClick={() => onOpen(item.id)}
                >
                  <span className={styles.time}>{clockTime(item.createdAt)}</span>
                  <span className={styles.name}>{item.title}</span>
                  <span className={styles.words}>{item.wordCount}</span>
                </button>

                <button
                  type="button"
                  className={styles.remove}
                  data-confirm={confirmId === item.id}
                  onClick={() => void handleDelete(item.id)}
                >
                  {confirmId === item.id ? '确认' : '删除'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {items.length > 0 && (
        <p className={styles.foot}>共 {items.length} 篇，删除后不可恢复</p>
      )}
    </div>
  )
}
