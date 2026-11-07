import { useEffect, useState } from 'react'

import { getLastRawResponse } from '@/api/client'
import { testConnection } from '@/api/llm'
import { getStudyProgress } from '@/api/study'
import { isOnlineLookupEnabled, saveOnlineLookup } from '@/data/dict'
import { clearAll } from '@/data/store'
import { exportAll } from '@/domain/export'
import { PROVIDERS, useLlm, type LlmProvider } from '@/store/llm'
import { useSession } from '@/store/session'
import { useToday } from '@/store/today'

import styles from './SettingsPage.module.css'

type Feedback = { kind: 'ok' | 'warn' | 'err'; text: string } | null

export default function SettingsPage() {
  const token = useSession((s) => s.token)
  const saveToken = useSession((s) => s.saveToken)
  const clearToken = useSession((s) => s.clearToken)
  const resetToday = useToday((s) => s.reset)

  const [input, setInput] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [exporting, setExporting] = useState<'csv' | 'md' | null>(null)
  const [online, setOnline] = useState(isOnlineLookupEnabled())

  const llmProvider = useLlm((s) => s.provider)
  const llmKey = useLlm((s) => s.apiKey)
  const saveLlm = useLlm((s) => s.save)
  const clearLlm = useLlm((s) => s.clear)

  const [providerDraft, setProviderDraft] = useState<LlmProvider>(llmProvider)
  const [llmInput, setLlmInput] = useState('')
  const [llmReveal, setLlmReveal] = useState(false)
  const [llmBusy, setLlmBusy] = useState(false)
  const [llmFeedback, setLlmFeedback] = useState<Feedback>(null)

  useEffect(() => {
    setOnline(isOnlineLookupEnabled())
  }, [])

  useEffect(() => {
    setProviderDraft(llmProvider)
  }, [llmProvider])

  async function handleToggleOnline(next: boolean) {
    setOnline(next)
    await saveOnlineLookup(next)
  }

  async function handleSaveLlm() {
    const value = llmInput.trim()
    if (!value) {
      setLlmFeedback({ kind: 'err', text: '请先粘贴 API Key' })
      return
    }

    setLlmBusy(true)
    setLlmFeedback(null)

    try {
      await saveLlm({ provider: providerDraft, apiKey: value })
      const reply = await testConnection()
      setLlmFeedback({ kind: 'ok', text: `连接成功，模型回复「${reply}」` })
      setLlmInput('')
    } catch (e) {
      setLlmFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '连接失败',
      })
    } finally {
      setLlmBusy(false)
    }
  }

  async function handleTestLlm() {
    setLlmBusy(true)
    setLlmFeedback(null)
    try {
      const reply = await testConnection()
      setLlmFeedback({ kind: 'ok', text: `连接正常，模型回复「${reply}」` })
    } catch (e) {
      setLlmFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '连接失败',
      })
    } finally {
      setLlmBusy(false)
    }
  }

  async function handleClearLlm() {
    await clearLlm()
    setLlmFeedback(null)
  }

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

  async function handleExport(format: 'csv' | 'md') {
    setExporting(format)
    setFeedback(null)
    try {
      const msg = await exportAll(format)
      setFeedback({ kind: 'ok', text: msg })
    } catch (e) {
      setFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '导出失败',
      })
    } finally {
      setExporting(null)
    }
  }

  async function handleClearAll() {
    await clearAll()
    resetToday()
    setFeedback({ kind: 'ok', text: '本地记录已清空' })
  }

  const raw = feedback?.kind === 'ok' ? null : getLastRawResponse()

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>设置</h1>

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

        {raw && feedback?.kind !== 'ok' && (
          <details className={styles.rawBox}>
            <summary>查看原始响应</summary>
            <pre>{raw}</pre>
          </details>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.label}>大模型</h2>
        <p className={styles.about}>
          阅读板块用它生成短文。当前使用 {PROVIDERS[llmProvider].name}，
          {PROVIDERS[llmProvider].pricing}。
        </p>

        {llmKey ? (
          <>
            <p className={styles.connected}>
              <span className={styles.dot} />
              已配置
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => void handleTestLlm()}
                disabled={llmBusy}
              >
                {llmBusy ? '测试中…' : '测试连接'}
              </button>
              <button type="button" className={styles.ghost} onClick={() => void handleClearLlm()}>
                清除
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.segments}>
              {(Object.keys(PROVIDERS) as LlmProvider[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={styles.segment}
                  data-on={providerDraft === p}
                  onClick={() => setProviderDraft(p)}
                >
                  {PROVIDERS[p].name}
                </button>
              ))}
            </div>

            <p className={styles.help}>{PROVIDERS[providerDraft].help}</p>

            <div className={styles.inputRow}>
              <input
                className={styles.input}
                type={llmReveal ? 'text' : 'password'}
                value={llmInput}
                onChange={(e) => setLlmInput(e.target.value)}
                placeholder="粘贴 API Key"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className={styles.toggle}
                onClick={() => setLlmReveal((v) => !v)}
              >
                {llmReveal ? '隐藏' : '显示'}
              </button>
            </div>

            <button
              type="button"
              className={styles.primary}
              onClick={() => void handleSaveLlm()}
              disabled={llmBusy}
            >
              {llmBusy ? '验证中…' : '保存并测试'}
            </button>
          </>
        )}

        {llmFeedback && (
          <p className={styles.feedback} data-kind={llmFeedback.kind}>
            {llmFeedback.text}
          </p>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.label}>查词</h2>

        <label className={styles.switchRow}>
          <span className={styles.switchText}>
            联网补查
            <em>本地词典没有的词（多是短语），用免费在线翻译兜底。查过的会存下来，不会重复请求。</em>
          </span>
          <input
            type="checkbox"
            className={styles.switch}
            checked={online}
            onChange={(e) => void handleToggleOnline(e.target.checked)}
          />
        </label>
      </section>

      <section className={styles.section}>
        <h2 className={styles.label}>数据</h2>
        <p className={styles.about}>
          记录只存在这台设备上。换手机或重装前，先导出一份。
        </p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void handleExport('csv')}
            disabled={exporting !== null}
          >
            {exporting === 'csv' ? '导出中…' : '导出 CSV'}
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void handleExport('md')}
            disabled={exporting !== null}
          >
            {exporting === 'md' ? '导出中…' : '导出 Markdown'}
          </button>
        </div>

        <button type="button" className={styles.danger} onClick={() => void handleClearAll()}>
          清空全部记录
        </button>
      </section>

      <section className={styles.section}>
        <h2 className={styles.label}>关于</h2>
        <p className={styles.about}>
          词迹记录你每天在墨墨背单词里新学、模糊、忘记的词。数据只存在这台设备上。
        </p>
        <p className={styles.meta}>版本 {__APP_VERSION__} · 基于墨墨开放 API（公测）</p>
      </section>
    </div>
  )
}
