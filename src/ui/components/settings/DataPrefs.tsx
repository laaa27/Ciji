import { useRef, useState, type ChangeEvent } from 'react'

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
import { useToday } from '@/store/today'

import styles from '../../pages/SettingsPage.module.css'

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

/**
 * 设置二级页：数据。
 * 导出、导入、清空——原样从 SettingsPage 拆出，状态自持。
 */
export default function DataPrefs() {
  const resetToday = useToday((s) => s.reset)

  const [exporting, setExporting] = useState<ExportFormat | null>(null)
  const [picked, setPicked] = useState<PickedFile | null>(null)
  const [importing, setImporting] = useState<ImportMode | null>(null)
  const [dataFeedback, setDataFeedback] = useState<Feedback>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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

  const pickedSummary = picked ? summarize(picked.days) : null
  const conflicts = picked ? picked.days.filter((d) => picked.existing.has(d.date)).length : 0
  const freshCount = pickedSummary ? pickedSummary.count - conflicts : 0

  return (
    <section className={styles.section}>
      <h2 className={styles.label}>备份与导出</h2>
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

      <p className={styles.warnNote}>
        提示：备份与导出功能目前仍在调整中，<strong>不保证可用</strong>。导出的文件可能缺字段或格式变动，
        导入也可能失败；在功能稳定之前，请不要把它当作唯一的数据保障。
      </p>
    </section>
  )
}
