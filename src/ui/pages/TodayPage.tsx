import { useEffect, useMemo, useRef, useState } from 'react'
import { Preferences } from '@capacitor/preferences'

import { lookupWords } from '@/data/dict'
import { lineState, responseNote } from '@/domain/collect'
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
  /** 全局是否展开释义。默认收起——先回想再核对，才符合记忆的顺序 */
  const [showGloss, setShowGloss] = useState(false)
  /** 单个词的临时覆盖：点一下收起/展开，优先级高于全局 */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  /** 已经贴到顶部的小标题；用来只在悬浮时画那条细线 */
  const [stuck, setStuck] = useState<Record<string, boolean>>({})
  const pageRef = useRef<HTMLDivElement>(null)

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

  /**
   * 分组标题吸顶。
   *
   * position: sticky 本身就会「被下一个标题顶走」（每个 head 的吸附范围被限在自身 section 里），
   * 这里只额外判断「是否已经贴住」，好在贴住时才画分隔细线 —— 没贴住时画线会多出一道横杠。
   */
  useEffect(() => {
    const page = pageRef.current
    if (!page) return

    // 滚动容器在 App 层，这里往上找第一个可滚动的祖先，不写死类名
    let scroller: HTMLElement | null = page.parentElement
    while (scroller) {
      const overflowY = getComputedStyle(scroller).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') break
      scroller = scroller.parentElement
    }
    if (!scroller) return

    const heads = () => Array.from(page.querySelectorAll<HTMLElement>('[data-group-head]'))
    let raf = 0

    const update = () => {
      raf = 0
      const base = scroller!.getBoundingClientRect().top
      const next: Record<string, boolean> = {}

      for (const head of heads()) {
        const key = head.dataset.groupHead ?? ''
        // 吸附阈值就是 CSS 里写的 top（可能带 max()/env()，用计算值最稳）
        const offset = parseFloat(getComputedStyle(head).top) || 0
        const top = head.getBoundingClientRect().top
        // 必须判「正好贴在阈值上」而不是「在阈值之上」：
        // 被下一个分组顶走的标题 top 会变成负数，那种不该算悬浮（否则细线会跟着跑）
        next[key] = top <= base + offset + 0.5 && top >= base + offset - 2
      }

      // 没变化就不 setState，滚动时别做多余渲染
      setStuck((prev) => {
        const keys = Object.keys(next)
        if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k])) {
          return prev
        }
        return next
      })
    }

    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    update()

    return () => {
      scroller?.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

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

      {snapshot?.warning && <p className={styles.warning}>{snapshot.warning}</p>}

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
