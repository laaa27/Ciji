import { useState } from 'react'

import { getLastRawResponse } from '@/api/client'
import { getStudyProgress } from '@/api/study'
import { useSession } from '@/store/session'
import { useToday } from '@/store/today'

import styles from '../../pages/SettingsPage.module.css'

/**
 * 设置二级页：墨墨账号。
 * 从 SettingsPage 原样拆出——连接凭证、测试、断开，逻辑不变。
 */
export default function MemoAccount() {
  const token = useSession((s) => s.token)
  const saveToken = useSession((s) => s.saveToken)
  const clearToken = useSession((s) => s.clearToken)
  const resetToday = useToday((s) => s.reset)

  const [input, setInput] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(
    null,
  )

  async function handleConnect() {
    const value = input.trim()
    if (!value) {
      setFeedback({ kind: 'err', text: '请先粘贴凭证' })
      return
    }

    setBusy(true)
    setFeedback(null)

    try {
      // 先用临时 token 探一次，确认凭证本身可用
      const res = await getStudyProgress(value)
      await saveToken(value)
      setInput('')
      resetToday()

      if (res?.progress && typeof res.progress.finished === 'number') {
        setFeedback({
          kind: 'ok',
          text: `连接成功。今日已完成 ${res.progress.finished}/${res.progress.total || '—'}`,
        })
      } else {
        const raw = getLastRawResponse()
        setFeedback({
          kind: 'warn',
          text:
            '凭证有效，但接口没有返回今日学习数据。请确认墨墨 App 里已开启「自动同步」，并且今天打开过 App。' +
            (raw ? `（原始响应：${raw.slice(0, 120)}）` : ''),
        })
      }
    } catch (e) {
      setFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '连接失败，请检查凭证',
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleRetest() {
    setBusy(true)
    setFeedback(null)
    try {
      const res = await getStudyProgress()
      if (res?.progress && typeof res.progress.finished === 'number') {
        setFeedback({
          kind: 'ok',
          text: `连接正常。今日已完成 ${res.progress.finished}/${res.progress.total || '—'}`,
        })
      } else {
        const raw = getLastRawResponse()
        setFeedback({
          kind: 'warn',
          text:
            '接口通了，但没有学习数据。今天还没打开过墨墨 App，或没开启「自动同步」。' +
            (raw ? `（原始响应：${raw.slice(0, 120)}）` : ''),
        })
      }
      resetToday()
    } catch (e) {
      setFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '连接失败',
      })
    } finally {
      setBusy(false)
    }
  }

  async function handleDisconnect() {
    await clearToken()
    resetToday()
    setFeedback(null)
  }

  const raw = feedback?.kind === 'ok' ? null : getLastRawResponse()

  return (
    <section className={styles.section}>
      <h2 className={styles.label}>接口凭证</h2>

      {token ? (
        <>
          <p className={styles.connected}>
            <span className={styles.dot} />
            凭证已保存
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => void handleRetest()}
              disabled={busy}
            >
              {busy ? '测试中…' : '测试连接'}
            </button>
            <button type="button" className={styles.ghost} onClick={() => void handleDisconnect()}>
              断开并清除
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={styles.inputRow}>
            <input
              className={styles.input}
              type={reveal ? 'text' : 'password'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="粘贴开放 API 凭证"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className={styles.toggle}
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? '隐藏' : '显示'}
            </button>
          </div>

          <p className={styles.help}>
            在墨墨 App 里获取：我的 → 更多设置 → 实验功能 → 开放 API
          </p>

          <button
            type="button"
            className={styles.primary}
            onClick={() => void handleConnect()}
            disabled={busy}
          >
            {busy ? '连接中…' : '保存并测试'}
          </button>
        </>
      )}

      {feedback && (
        <p className={styles.feedback} data-kind={feedback.kind}>
          {feedback.text}
        </p>
      )}

      {raw && (
        <details className={styles.rawBox}>
          <summary>查看原始响应</summary>
          <pre>{raw}</pre>
        </details>
      )}
    </section>
  )
}
