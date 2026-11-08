import { useEffect, useState } from 'react'

import { lookupOne } from '@/data/dict'
import { addToPlan, lookupMemoState, type MemoState } from '@/domain/memo'
import { RESPONSE_LABEL } from '@/domain/collect'
import { dateKey, diffDays, monthDay } from '@/lib/date'
import { useSession } from '@/store/session'
import styles from './WordSheet.module.css'

type Props = {
  word: string
  onClose: () => void
}

const TAG_LABEL: Record<string, string> = {
  STICKING: '顽固词',
  WELL_FAMILIAR: '熟知',
}

/** ISO → 11月10日；不是今年的会带上年份，免得把明年看成下个月 */
function dayLabel(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''

  const key = dateKey(d)
  const label = monthDay(key)
  const thisYear = dateKey(new Date()).slice(0, 4)
  return key.slice(0, 4) === thisYear ? label : `${key.slice(0, 4)}年${label}`
}

/** ISO → 距今几天（0 = 今天） */
function daysSince(iso?: string): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return diffDays(dateKey(new Date()), dateKey(d))
}

export default function WordSheet({ word, onClose }: Props) {
  const token = useSession((s) => s.token)

  const [gloss, setGloss] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** 关闭时先播出场动画，播完再真正卸载 */
  const [closing, setClosing] = useState(false)

  /** 墨墨状态：null 表示还没拿到（或没连墨墨） */
  const [memo, setMemo] = useState<MemoState | null>(null)
  const [memoLoading, setMemoLoading] = useState(false)
  /** 加词要点两次：第一次只把按钮变成「确认加入」 */
  const [confirming, setConfirming] = useState(false)
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

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

  // 释义先出，墨墨状态后补：网络慢不该挡住看释义
  useEffect(() => {
    if (!token) return
    let alive = true
    setMemo(null)
    setMemoLoading(true)
    setConfirming(false)
    setNotice(null)

    void lookupMemoState(word).then((state) => {
      if (!alive) return
      setMemo(state)
      setMemoLoading(false)
    })
    return () => {
      alive = false
    }
  }, [word, token])

  async function handleAdd() {
    if (!confirming) {
      setConfirming(true)
      setNotice(null)
      return
    }

    setAdding(true)
    const res = await addToPlan(word)
    setAdding(false)
    setConfirming(false)
    setNotice({ ok: res.ok, text: res.message })

    if (res.ok) setMemo(await lookupMemoState(word))
  }

  const record = memo?.kind === 'in-plan' ? memo.record : null
  const joinedDays = record ? daysSince(record.add_date) : null
  const tag = record?.tags ? TAG_LABEL[record.tags] : ''

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

        {token && (
          <section className={styles.memo}>
            {memoLoading && <p className={styles.memoMuted}>墨墨状态读取中…</p>}

            {record && (
              <>
                <p className={styles.memoHead}>
                  已在学习计划
                  {joinedDays !== null && joinedDays >= 0 && (
                    <span className={styles.memoDim}>
                      {' · '}
                      {joinedDays === 0 ? '今天加入' : `加入 ${joinedDays} 天`}
                    </span>
                  )}
                  {tag && <span className={styles.memoTag}>{tag}</span>}
                </p>
                <p className={styles.memoLine}>
                  背过 {record.study_count} 次
                  {record.last_response && ` · 上次「${RESPONSE_LABEL[record.last_response]}」`}
                </p>
                {record.next_study_date && (
                  <p className={styles.memoLine}>
                    下次复习 {dayLabel(record.next_study_date) || '—'}
                  </p>
                )}
              </>
            )}

            {memo?.kind === 'available' && (
              <>
                <p className={styles.memoHead}>
                  还没加入墨墨
                  <span className={styles.memoDim}> · 词库里有这个词</span>
                </p>
                <button
                  type="button"
                  className={styles.memoButton}
                  data-confirm={confirming}
                  onClick={() => void handleAdd()}
                  disabled={adding}
                >
                  {adding ? '加入中…' : confirming ? '确认加入？' : '加入学习计划'}
                </button>
                {confirming && (
                  <p className={styles.memoMuted}>
                    会占用今天的单词额度，加完按墨墨的排期复习。
                  </p>
                )}
              </>
            )}

            {memo?.kind === 'unknown' && (
              <p className={styles.memoMuted}>墨墨词库里没有这个词，加不进去。</p>
            )}

            {memo?.kind === 'error' && (
              <p className={styles.memoMuted}>墨墨状态读取失败：{memo.message}</p>
            )}

            {notice && (
              <p className={styles.memoNotice} data-ok={notice.ok}>
                {notice.text}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
