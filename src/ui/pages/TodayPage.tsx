import { useEffect, useMemo, useRef, useState } from 'react'
import { Preferences } from '@capacitor/preferences'

import { lookupWords } from '@/data/dict'
import { lineState, responseNote } from '@/domain/collect'
import { clockTime, dateKey, monthDay, weekday } from '@/lib/date'
import { useSession } from '@/store/session'
import { useToday } from '@/store/today'

import { useScrollStuckGroup } from '../hooks/useScrollStuck'
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
  const refreshing = useToday((s) => s.refreshing)
  const errorDetail = useToday((s) => s.errorDetail)
  const refresh = useToday((s) => s.refresh)

  const today = dateKey()

  const [glosses, setGlosses] = useState<Record<string, string>>({})
  /** 全局是否展开释义。默认收起——先回想再核对，才符合记忆的顺序 */
  const [showGloss, setShowGloss] = useState(false)
  /** 单个词的临时覆盖：点一下收起/展开，优先级高于全局 */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  const pageRef = useRef<HTMLDivElement>(null)
  /** 已经贴到顶部的小标题；用来只在悬浮时画那条细线 */
  const stuck = useScrollStuckGroup(pageRef, '[data-group-head]', 'groupHead')

  const isGlossShown = (vocId: string) => overrides[vocId] ?? showGloss

  function toggleGloss(vocId: string) {
    setOverrides((prev) => ({ ...prev, [vocId]: !(prev[vocId] ?? showGloss) }))
  }

  function toggleAllGloss() {
    // 切全局时清掉个体覆盖，回到统一状态
    setOverrides({})
    setShowGloss((v) => {
      void Preferences.set({ key: 'today_show_gloss', value: v ? 'false' : 'true' })
      return !v
    })
  }

  useEffect(() => {
    void Preferences.get({ key: 'today_show_gloss' }).then(({ value }) => {
      if (value === 'true') setShowGloss(true)
    })
  }, [])

  useEffect(() => {
    if (!sessionReady || !token) return
    void refresh()
  }, [sessionReady, token, refresh])

  useEffect(() => {
    if (!snapshot || snapshot.words.length === 0) return
    let alive = true
    const merge = (m: Map<string, string>) => {
      if (!alive) return
      setGlosses((prev) => ({ ...prev, ...Object.fromEntries(m) }))
    }
    void lookupWords(snapshot.words.map((w) => w.spelling), { onLocal: merge }).then(merge)
    return () => {
      alive = false
    }
  }, [snapshot])

  const groups = useMemo(() => {
    const words = snapshot?.words ?? []
    return GROUP_META.map((meta) => ({
      ...meta,
      items: words.filter((w) => w.groups.includes(meta.key)),
    }))
  }, [snapshot])

  const loading = status === 'loading' && !snapshot
  const minutes = snapshot ? Math.round(snapshot.studyTimeMs / 60000) : 0
  const pct =
    snapshot && snapshot.total > 0
      ? Math.min(100, (snapshot.finished / snapshot.total) * 100)
      : 0

  return (
    <div className={styles.page} ref={pageRef}>
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
                data-on={showGloss}
                onClick={toggleAllGloss}
              >
                释义
              </button>
              <button
                type="button"
                className={styles.refresh}
                onClick={() => void refresh(true)}
                disabled={refreshing}
              >
                {refreshing ? '读取中' : '刷新'}
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

      {snapshot?.warning && <p className={styles.warning}>{snapshot.warning}</p>}

      {/*
        有旧数据、只是这次没刷上：不能把已经采到的词撤掉换成一块红字。
        一条可点的提示就够了 —— 用户要的是词，不是错误详情。
        「详情」默认收起，但一定要有：同样是这句文案，
        HTTP 500 和 200 带错误信封的定性完全相反，只有原始响应能分清。
      */}
      {token && status === 'error' && snapshot && (
        <div className={styles.retryBox}>
          <button
            type="button"
            className={styles.retryWarn}
            onClick={() => void refresh(true)}
            data-testid="refresh-failed"
          >
            这次没刷上：{error} · 点这里重试
          </button>

          {errorDetail && (
            <details className={styles.retryDetail} data-testid="refresh-detail">
              <summary>详情</summary>
              <pre>
                {`HTTP ${errorDetail.status ?? '—'} · ${errorDetail.code ?? '无错误码'}`}
                {errorDetail.raw ? `\n\n${errorDetail.raw.slice(0, 400)}` : ''}
              </pre>
            </details>
          )}
        </div>
      )}

      {/*
        诊断行只在有词的时候出现。
        接口在「今天还没学」时也会返回一份今日待学/历史状态的词表，
        那些条目的 is_finished / first_response 带着旧值，数出来的「今天学过 157 条」
        会和下面的「今天还没有学习记录」直接打架 —— 所以空列表时不显示。
      */}
      {token && snapshot && snapshot.words.length > 0 && (
        <p className={styles.diag}>
          接口返回 {snapshot.rawCount} 条 · 进入记录 {snapshot.words.length} 个 · 其中新学{' '}
          {groups[0].items.length} 个
        </p>
      )}

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

      {token && loading && (
        <p className={`${styles.hint} loading-pulse`}>正在读取今天的学习记录…</p>
      )}

      {/* 完全没数据时才占整屏报错；有数据的情况走上面那条细提示 */}
      {token && status === 'error' && !snapshot && (
        <div className={styles.notice}>
          <p className={styles.noticeTitle}>没能读到数据</p>
          <p className={styles.noticeText}>{error}</p>
          <button type="button" className={styles.button} onClick={() => void refresh(true)}>
            重试
          </button>
        </div>
      )}

      {token && snapshot && snapshot.words.length === 0 && (
        <div className={styles.emptyDay}>
          <p className={styles.emptyDayTitle}>今天还没开始</p>
          <p className={styles.emptyDayText}>
            在墨墨里学几个词，回来点一下刷新。新学、模糊、忘记的词会分三组列在这里。
          </p>
        </div>
      )}

      {token &&
        snapshot &&
        snapshot.words.length > 0 &&
        groups.map((group) => (
          <section key={group.key} className={styles.group}>
            <div
              className={styles.groupHead}
              data-group-head={group.key}
              data-stuck={stuck[group.key] ? 'true' : 'false'}
            >
              <h2 className={styles.groupTitle}>{group.title}</h2>
              <span className={styles.groupCount}>{group.items.length}</span>
            </div>

            {group.items.length === 0 ? (
              <p className={styles.empty}>这一组今天没有词</p>
            ) : (
              <ul>
                {group.items.map((word) => (
                  <WordRow
                    key={`${group.key}-${word.vocId}`}
                    spelling={word.spelling}
                    gloss={glosses[word.spelling.toLowerCase()]}
                    state={lineState(word)}
                    note={responseNote(word)}
                    glossVisible={isGlossShown(word.vocId)}
                    onToggle={() => toggleGloss(word.vocId)}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}

      {token && snapshot && snapshot.words.length === 0 && null}
    </div>
  )
}
