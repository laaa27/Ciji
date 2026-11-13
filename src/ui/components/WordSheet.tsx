import { useEffect, useState } from 'react'

import { lookupOneDetailed } from '@/data/dict'
import { addToPlan, advanceWord, lookupMemoState, type MemoState } from '@/domain/memo'
import type { PhraseHit } from '@/domain/phrase'
import { inflectionFamily } from '@/domain/wordforms'
import { RESPONSE_LABEL } from '@/domain/collect'
import { dateKey, diffDays, monthDay } from '@/lib/date'
import { useSession } from '@/store/session'
import { useScrollLock } from '../hooks/useScrollLock'
import styles from './WordSheet.module.css'

type Props = {
  word: string
  /**
   * 点词时在上下文里匹配到的固定搭配。
   * 有值就先展示短语（聊天式地补上来，不打断已经显示的单词释义），
   * 用户随时能切回单词——因为"我其实只想查这个词"完全合理。
   */
  phrase?: PhraseHit | null
  onClose: () => void
  /** 点变形小标签：换成那个词重新查 */
  onPick: (word: string) => void
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

export default function WordSheet({ word, phrase, onClose, onPick }: Props) {
  const token = useSession((s) => s.token)

  // 弹层开着时，背景里的文章不该还能被手指带着滚（见 hook 注释）
  useScrollLock(true)

  /** 短语 / 单词：匹配到短语时默认看短语，但可以一键切回来 */
  const [view, setView] = useState<'phrase' | 'word'>(phrase ? 'phrase' : 'word')
  const target = view === 'phrase' && phrase ? phrase.text : word

  const [gloss, setGloss] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** 这条释义是不是 AI 给的（本地词典/缓存/在线兜底都是 false） */
  const [aiGloss, setAiGloss] = useState(false)
  /** 关闭时先播出场动画，播完再真正卸载 */
  const [closing, setClosing] = useState(false)

  /** 墨墨状态：null 表示还没拿到（或没连墨墨） */
  const [memo, setMemo] = useState<MemoState | null>(null)
  const [memoLoading, setMemoLoading] = useState(false)
  /** 加词要点两次：第一次只把按钮变成「确认加入」 */
  const [confirming, setConfirming] = useState(false)
  const [adding, setAdding] = useState(false)
  const [advancing, setAdvancing] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  /** 同族变形（原形 + 本地词典里真实存在的其他形式） */
  const [forms, setForms] = useState<string[]>([])

  useEffect(() => {
    setView(phrase ? 'phrase' : 'word')
  }, [phrase, word])

  function requestClose() {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, 180)
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    setGloss(null)
    setAiGloss(false)
    void lookupOneDetailed(target, {
      // 本地词典/缓存命中时先渲染——AI 释义要走一次网络调用，不该挡住瞬时查询。
      // 来源标记也一起给：缓存里的 AI 释义不该先按普通释义闪一帧
      onLocal: (g, fromAi) => {
        if (!alive) return
        setGloss(g)
        setAiGloss(fromAi)
        setLoading(false)
      },
    }).then((res) => {
      if (!alive) return
      setGloss(res.gloss)
      setAiGloss(res.ai)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [target])

  // 释义先出，墨墨状态后补：网络慢不该挡住看释义
  useEffect(() => {
    if (!token) return
    let alive = true
    setMemo(null)
    setMemoLoading(true)
    setConfirming(false)
    setNotice(null)

    void lookupMemoState(target).then((state) => {
      if (!alive) return
      setMemo(state)
      setMemoLoading(false)
    })
    return () => {
      alive = false
    }
  }, [target, token])

  // 变形标签：定位到原形之后再算，纯本地，不发请求
  useEffect(() => {
    // 短语没有"变形家族"，只有单词才列
    if (view === 'phrase' || !memo || (memo.kind !== 'in-plan' && memo.kind !== 'available')) {
      setForms([])
      return
    }

    const base =
      memo.kind === 'in-plan'
        ? memo.record.voc_spelling
        : memo.kind === 'available'
          ? memo.spelling
          : target

    let alive = true
    void inflectionFamily(base, gloss, [target]).then((list) => {
      if (alive) setForms(list)
    })
    return () => {
      alive = false
    }
  }, [memo, gloss, view, target])

  async function handleAdvance() {
    setAdvancing(true)
    setNotice(null)
    const res = await advanceWord(target)
    setAdvancing(false)
    setNotice({ ok: res.ok, text: res.message })

    if (res.ok) setMemo(await lookupMemoState(target))
  }

  async function handleAdd() {
    if (!confirming) {
      setConfirming(true)
      setNotice(null)
      return
    }

    setAdding(true)
    const res = await addToPlan(target)
    setAdding(false)
    setConfirming(false)
    setNotice({ ok: res.ok, text: res.message })

    if (res.ok) setMemo(await lookupMemoState(target))
  }

  const record = memo?.kind === 'in-plan' ? memo.record : null
  const joinedDays = record ? daysSince(record.add_date) : null
  const tag = record?.tags ? TAG_LABEL[record.tags] : ''

  /*
   * 「这个词本身在计划里」和「它猜出来的原形在计划里」是两件事，必须分开写。
   * 以前统一写成「已在学习计划 · 原形 file」，读起来像在陈述事实，用户会以为
   * filing 本身在计划里 —— 实际上那只是猜的。
   */
  const missingExact = memo && (memo.kind === 'in-plan' || memo.kind === 'available') && !memo.exact

  return (
    <div className={styles.mask} data-closing={closing} onClick={requestClose} role="presentation">
      <div
        className={styles.sheet}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${target} 的释义`}
      >
        <div className={styles.handle} />
        <div className={styles.head}>
          <span className={styles.word}>{target}</span>
          <button type="button" className={styles.close} onClick={requestClose} aria-label="关闭">
            关闭
          </button>
        </div>
        {phrase && (
          <div className={styles.views}>
            <button
              type="button"
              className={styles.viewChip}
              data-on={view === 'phrase'}
              onClick={() => setView('phrase')}
            >
              短语
            </button>
            <button
              type="button"
              className={styles.viewChip}
              data-on={view === 'word'}
              onClick={() => setView('word')}
            >
              {word}
            </button>
          </div>
        )}

        <p className={styles.gloss}>
          {loading ? (
            '查询中…'
          ) : (
            <>
              {gloss || '没有查到这个词的释义'}
              {aiGloss && gloss && <span className={styles.aiTag}>AI 释义</span>}
            </>
          )}
        </p>

        {view === 'word' && forms.length > 1 && (
          <div className={styles.forms}>
            {forms.map((f) => (
              <button
                key={f}
                type="button"
                className={styles.form}
                data-on={f === word.toLowerCase()}
                onClick={() => onPick(f)}
              >
                {f}
              </button>
            ))}
          </div>
        )}

        {token && (
          <section className={styles.memo}>
            {memoLoading && <p className={styles.memoMuted}>墨墨状态读取中…</p>}

            {/* 原词不在词库里：先把这件事说明白，再说它的原形 —— 顺序反了就成了「猜的当事实」 */}
            {missingExact && <p className={styles.memoMuted}>墨墨词库里没有「{target}」</p>}

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
                  <p className={styles.memoLine}>
                    下次复习 {dayLabel(memo.record.next_study_date) || '—'}
                  </p>
                )}

                <button
                  type="button"
                  className={styles.memoButton}
                  onClick={() => void handleAdvance()}
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
