import { useEffect, useMemo, useState } from 'react'

import { lookupWords } from '@/data/dict'
import { responseNote } from '@/domain/collect'
import { clockTime, dateKey, monthDay, weekday } from '@/lib/date'
import { useSession } from '@/store/session'
import { useToday } from '@/store/today'

import WordRow from '../components/WordRow'
import styles from './TodayPage.module.css'

type Props = {
  onGoSettings: () => void
}

const GROUP_META = [
  { key: 'new', title: '新学' },
  { key: 'vague', title: '模糊' },
  { key: 'forget', title: '忘记' },
] as const

export default function TodayPage({ onGoSettings }: Props) {
  const token = useSession((s) => s.token)
  const sessionReady = useSession((s) => s.ready)

  const snapshot = useToday((s) => s.snapshot)
  const status = useToday((s) => s.status)
  const error = useToday((s) => s.error)
  const refresh = useToday((s) => s.refresh)

  const today = dateKey()

  const [glosses, setGlosses] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!sessionReady || !token) return
    void refresh()
  }, [sessionReady, token, refresh])

  useEffect(() => {
    if (!snapshot || snapshot.words.length === 0) return
    let alive = true
    void lookupWords(snapshot.words.map((w) => w.spelling)).then((map) => {
      if (!alive) return
      setGlosses(Object.fromEntries(map))
    })
    return () => {
      alive = false
    }
  }, [snapshot])

  const groups = useMemo(() => {
    const words = snapshot?.words ?? []
    return GROUP_META.map((meta) => ({
      ...meta,
      items: words.filter((w) => w.state === meta.key),
    }))
  }, [snapshot])

  const loading = status === 'loading' && !snapshot
  const minutes = snapshot ? Math.round(snapshot.studyTimeMs / 60000) : 0
  const pct =
    snapshot && snapshot.total > 0
      ? Math.min(100, (snapshot.finished / snapshot.total) * 100)
      : 0

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.dateRow}>
          <h1 className={styles.date}>{monthDay(today)}</h1>
          <span className={styles.weekday}>{weekday(today)}</span>

          {token && (
            <span className={styles.topRight}>
              {snapshot && <span className={styles.updated}>{clockTime(snapshot.collectedAt)}</span>}
              <button
                type="button"
                className={styles.refresh}
                onClick={() => void refresh(true)}
                disabled={status === 'loading'}
              >
                {status === 'loading' ? '读取中' : '刷新'}
              </button>
            </span>
          )}
        </div>

        {snapshot && (
          <div className={styles.progress}>
            <div className={styles.progressLine}>
              <span className={styles.progressMain}>
                <span className={styles.progressNum}>{snapshot.finished}</span>
                <span className={styles.progressSlash}>/</span>
                <span className={styles.progressTotal}>{snapshot.total || '—'}</span>
              </span>
              <span className={styles.progressTime}>{minutes} 分钟</span>
            </div>
            <div className={styles.track}>
              <div className={styles.fill} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </header>

      {!sessionReady && null}

      {sessionReady && !token && (
        <div className={styles.notice}>
          <p className={styles.noticeTitle}>还没有连接墨墨</p>
          <p className={styles.noticeText}>
            填入接口凭证后，这里会显示你每天新学、模糊、忘记的单词。
          </p>
          <button type="button" className={styles.button} onClick={onGoSettings}>
            去设置
          </button>
        </div>
      )}

      {token && loading && <p className={styles.hint}>正在读取今天的学习记录…</p>}

      {token && status === 'error' && (
        <div className={styles.notice}>
          <p className={styles.noticeTitle}>没能读到数据</p>
          <p className={styles.noticeText}>{error}</p>
          <button type="button" className={styles.button} onClick={() => void refresh(true)}>
            重试
          </button>
        </div>
      )}

      {token && snapshot && snapshot.words.length === 0 && (
        <p className={styles.hint}>
          今天还没有学习记录。去墨墨背几个词，回来刷新一下。
        </p>
      )}

      {token &&
        snapshot &&
        snapshot.words.length > 0 &&
        groups.map((group) => (
          <section key={group.key} className={styles.group}>
            <div className={styles.groupHead}>
              <h2 className={styles.groupTitle}>{group.title}</h2>
              <span className={styles.groupCount}>{group.items.length}</span>
            </div>

            {group.items.length === 0 ? (
              <p className={styles.empty}>这一组今天没有词</p>
            ) : (
              <ul>
                {group.items.map((word) => (
                  <WordRow
                    key={word.vocId}
                    spelling={word.spelling}
                    gloss={glosses[word.spelling.toLowerCase()]}
                    state={word.state}
                    note={responseNote(word)}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}
    </div>
  )
}
