import { RESPONSE_LABEL } from '@/domain/collect'
import { dateKey, diffDays, monthDay } from '@/lib/date'
import type { MemoBundle } from '../../hooks/useMemoState'

import styles from '../WordSheet.module.css'

/**
 * 词卡下半部分的「墨墨」区：计划状态、背过几次、下次复习、加词 / 提前复习。
 *
 * 纯展示 + 两个按钮，状态与写接口都在 `useMemoState` 里。抽出来的理由是
 * 这里与「显示释义」毫无关系，只因为都在同一张词卡里才住在一起。
 */

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

export default function MemoPanel({ word, memos }: { word: string; memos: MemoBundle }) {
  const { memo, loading, confirming, adding, advancing, notice } = memos
  if (!memos.hasToken) return null

  const record = memo?.kind === 'in-plan' ? memo.record : null
  const joinedDays = record ? daysSince(record.add_date) : null
  const tag = record?.tags ? TAG_LABEL[record.tags] : ''

  /*
   * 「这个词本身在计划里」和「它猜出来的原形在计划里」是两件事，必须分开写。
   * 以前统一写成「已在学习计划 · 原形 file」，读起来像在陈述事实，用户会以为
   * filing 本身在计划里 —— 实际上那只是猜的。
   */
  const missingExact =
    memo && (memo.kind === 'in-plan' || memo.kind === 'available') && !memo.exact

  return (
    <section className={styles.memo}>
      {loading && <p className={styles.memoMuted}>墨墨状态读取中…</p>}

      {/* 原词不在词库里：先把这件事说明白，再说它的原形 —— 顺序反了就成了「猜的当事实」 */}
      {missingExact && <p className={styles.memoMuted}>墨墨词库里没有「{word}」</p>}

      {memo?.kind === 'in-plan' && (
        <>
          <p className={styles.memoHead}>
            {memo.exact ? '已在学习计划' : `${memo.record.voc_spelling} 已在学习计划`}
            {joinedDays !== null && joinedDays >= 0 && (
              <span className={styles.memoDim}>
                {' · '}
                {joinedDays === 0 ? '今天加入' : `加入 ${joinedDays} 天`}
              </span>
            )}
            {tag && <span className={styles.memoTag}>{tag}</span>}
          </p>
          <p className={styles.memoLine}>
            背过 {memo.record.study_count} 次
            {memo.record.last_response &&
              ` · 上次「${RESPONSE_LABEL[memo.record.last_response]}」`}
          </p>
          {memo.record.next_study_date && (
            <p className={styles.memoLine}>下次复习 {dayLabel(memo.record.next_study_date) || '—'}</p>
          )}

          <button
            type="button"
            className={styles.memoButton}
            onClick={() => void memos.advance()}
            disabled={advancing}
          >
            {advancing ? '提前中…' : '提前复习'}
          </button>
        </>
      )}

      {memo?.kind === 'available' && (
        <>
          <p className={styles.memoHead}>
            {memo.exact ? (
              <>
                还没加入墨墨
                <span className={styles.memoDim}> · 词库里有这个词</span>
              </>
            ) : (
              <>
                词库里最接近的是 {memo.spelling}
                <span className={styles.memoDim}> · 加入的是它</span>
              </>
            )}
          </p>
          <button
            type="button"
            className={styles.memoButton}
            data-confirm={confirming}
            onClick={() => void memos.add()}
            disabled={adding}
          >
            {adding ? '加入中…' : confirming ? '确认加入？' : '加入学习计划'}
          </button>
          {confirming && (
            <p className={styles.memoMuted}>会占用今天的单词额度，加完按墨墨的排期复习。</p>
          )}
        </>
      )}

      {memo?.kind === 'unknown' && <p className={styles.memoMuted}>墨墨词库里没有这个词，加不进去。</p>}

      {memo?.kind === 'error' && (
        <p className={styles.memoMuted}>墨墨状态读取失败：{memo.message}</p>
      )}

      {notice && (
        <p className={styles.memoNotice} data-ok={notice.ok}>
          {notice.text}
        </p>
      )}
    </section>
  )
}
