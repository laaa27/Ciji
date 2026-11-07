import { useEffect, useRef, useState, type ChangeEvent } from 'react'

import { getLastRawResponse } from '@/api/client'
import { testConnection } from '@/api/llm'
import { getStudyProgress } from '@/api/study'
import { isOnlineLookupEnabled, saveOnlineLookup } from '@/data/dict'
import { clearAll, listDays, writeDays } from '@/data/store'
import {
  parseImportText,
  planImport,
  summarize,
  type ImportMode,
  type ImportSource,
} from '@/domain/backup'
import type { TodaySnapshot } from '@/domain/collect'
import { exportAll, exportBackup } from '@/domain/export'
import { PROVIDERS, useLlm, type LlmProvider } from '@/store/llm'
import { useSession } from '@/store/session'
import { useToday } from '@/store/today'

import styles from './SettingsPage.module.css'

type Feedback = { kind: 'ok' | 'warn' | 'err'; text: string } | null

type ExportFormat = 'csv' | 'md' | 'json'

/** 选完文件后、写盘之前的状态：先让用户看清要做什么 */
type PickedFile = {
  name: string
  source: ImportSource
  days: TodaySnapshot[]
  notes: string[]
  existing: Set<string>
}

export default function SettingsPage() {
  const token = useSession((s) => s.token)
  const saveToken = useSession((s) => s.saveToken)
  const clearToken = useSession((s) => s.clearToken)
  const resetToday = useToday((s) => s.reset)

  const [input, setInput] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  const [online, setOnline] = useState(isOnlineLookupEnabled())

  const [picked, setPicked] = useState<PickedFile | null>(null)
  const [importing, setImporting] = useState<ImportMode | null>(null)
  // 数据区的提示与「凭证」区分开，否则导出成功会同时出现在两个 section 里
  const [dataFeedback, setDataFeedback] = useState<Feedback>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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

  // 数据区的提示与「凭证」区分开，否则导出成功会同时出现在两个 section 里

  async function handleExport(format: ExportFormat) {
    setExporting(format)
    setDataFeedback(null)
    try {
      const msg = format === 'json' ? await exportBackup() : await exportAll(format)
      setDataFeedback({ kind: 'ok', text: msg })
    } catch (e) {
      setDataFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '导出失败',
      })
    } finally {
      setExporting(null)
    }
  }

  async function handlePickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // 清空 value，让同一个文件能再选一次（换个策略重导时常用）
    event.target.value = ''
    if (!file) return

    setDataFeedback(null)
    setPicked(null)

    try {
      const text = await file.text()
      const parsed = parseImportText(file.name, text)
      const existing = new Set(await listDays())
      setPicked({
        name: file.name,
        source: parsed.source,
        days: parsed.days,
        notes: parsed.notes,
        existing,
      })
    } catch (e) {
      setDataFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '读取文件失败',
      })
    }
  }

  async function handleImport(mode: ImportMode) {
    if (!picked) return

    setImporting(mode)
    setDataFeedback(null)

    try {
      const plan = planImport(picked.days, picked.existing, mode)
      if (plan.write.length === 0) {
        setDataFeedback({
          kind: 'warn',
          text: `文件里 ${picked.days.length} 天的记录本地都已存在，没有写入任何数据`,
        })
        return
      }

      await writeDays(plan.write)
      // 今天的数据可能就在这次导入里，界面上的今日页要跟着变
      await useToday.getState().loadFromStorage()

      const parts: string[] = []
      if (plan.added > 0) parts.push(`新增 ${plan.added} 天`)
      if (plan.replaced > 0) parts.push(`覆盖 ${plan.replaced} 天`)
      if (plan.kept > 0) parts.push(`保留本地 ${plan.kept} 天`)

      setDataFeedback({ kind: 'ok', text: `导入完成：${parts.join('，')}` })
      setPicked(null)
    } catch (e) {
      setDataFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '导入失败',
      })
    } finally {
      setImporting(null)
    }
  }

  async function handleClearAll() {
    await clearAll()
    resetToday()
    setDataFeedback({ kind: 'ok', text: '本地记录已清空' })
  }

  const raw = feedback?.kind === 'ok' ? null : getLastRawResponse()

  const pickedSummary = picked ? summarize(picked.days) : null
  const conflicts = picked ? picked.days.filter((d) => picked.existing.has(d.date)).length : 0
  const freshCount = pickedSummary ? pickedSummary.count - conflicts : 0

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
          记录只存在这台设备上。换手机或重装前，先导出一份备份。
        </p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void handleExport('json')}
            disabled={exporting !== null}
          >
            {exporting === 'json' ? '导出中…' : '导出备份'}
          </button>
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

        <p className={styles.help}>
          「导出备份」是 JSON，能原样导回；CSV 和 Markdown 用来给别人看，
          只有日期和单词，导回来会丢学习时长与逐词反馈。
        </p>

        <div className={styles.importBlock}>
          <h3 className={styles.subLabel}>导入</h3>

          <input
            ref={fileRef}
            type="file"
            className={styles.fileInput}
            // 带上 octet-stream：部分 ROM 把 .json 认成未知类型，只按 application/json
            // 过滤会让用户自己的备份文件在选择器里变灰
            accept=".json,.csv,application/json,text/csv,text/plain,application/octet-stream"
            onChange={(e) => void handlePickFile(e)}
          />

          <button
            type="button"
            className={styles.secondary}
            onClick={() => fileRef.current?.click()}
            disabled={importing !== null}
          >
            {picked ? '换一个文件…' : '选择文件…'}
          </button>

          {picked && pickedSummary && (
            <div className={styles.preview}>
              <p className={styles.previewName}>{picked.name}</p>
              <p className={styles.previewMeta}>
                {picked.source === 'csv' ? 'CSV' : '备份'} · {pickedSummary.count} 天 ·{' '}
                {pickedSummary.words} 个词
              </p>
              <p className={styles.previewMeta}>
                {pickedSummary.first} — {pickedSummary.last}
              </p>

              {conflicts > 0 && (
                <p className={styles.previewMeta} data-warn="true">
                  其中 {conflicts} 天本地已有记录
                </p>
              )}

              {picked.notes.map((note) => (
                <p key={note} className={styles.previewNote}>
                  {note}
                </p>
              ))}

              <div className={styles.actions}>
                {conflicts === 0 ? (
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => void handleImport('fill')}
                    disabled={importing !== null}
                  >
                    {importing ? '导入中…' : `导入 ${pickedSummary.count} 天`}
                  </button>
                ) : (
                  <>
                    {freshCount > 0 && (
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => void handleImport('fill')}
                        disabled={importing !== null}
                      >
                        {importing === 'fill' ? '导入中…' : `仅补 ${freshCount} 天`}
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.overwrite}
                      onClick={() => void handleImport('overwrite')}
                      disabled={importing !== null}
                    >
                      {importing === 'overwrite' ? '导入中…' : `覆盖 ${conflicts} 天`}
                    </button>
                  </>
                )}

                <button
                  type="button"
                  className={styles.ghost}
                  onClick={() => setPicked(null)}
                  disabled={importing !== null}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        {dataFeedback && (
          <p className={styles.feedback} data-kind={dataFeedback.kind}>
            {dataFeedback.text}
          </p>
        )}

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
