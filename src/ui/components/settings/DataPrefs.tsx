import { useRef, useState, type ChangeEvent } from 'react'

import { clearGlossCache } from '@/data/gloss'
import { clearArticles, listArticles, saveArticle } from '@/data/article'
import { clearAll, listDays, writeDays } from '@/data/store'
import {
  parseImportText,
  planImport,
  summarize,
  type ImportMode,
} from '@/domain/backup'
import type { Article } from '@/domain/article'
import type { TodaySnapshot } from '@/domain/collect'
import { exportBackup } from '@/domain/export'
import { useToday } from '@/store/today'

import styles from '../../pages/SettingsPage.module.css'

type FeedbackScope = 'export' | 'import' | 'articles' | 'gloss' | 'all'
/**
 * 提示挂在哪一块下面。
 *
 * 页面拆成并列的 section 之后，一条固定在「导入」下面的提示会让「导出成功」
 * 出现在隔壁区块里 —— 所以每条提示都标上它属于谁。
 */
type Feedback = { kind: 'ok' | 'warn' | 'err'; text: string; scope: FeedbackScope } | null

/** 选完文件后、写盘之前的状态：先让用户看清要做什么 */
type PickedFile = {
  name: string
  days: TodaySnapshot[]
  /** v2 起备份携带的生成文章；导入时跳过本地已有 id */
  articles: Article[]
  /** 其中本地没有的篇数（导入时会写入的） */
  newArticles: number
  notes: string[]
  existing: Set<string>
}

/**
 * 设置二级页：数据。
 *
 * 五块并列：备份与导出 / 导入 / 生成文章 / 释义缓存 / 全部记录。
 * 用与其它设置页相同的 section + label 结构 —— 以前是「一个大 section 里塞四个
 * h3 子块」，只有「导入」有一条虚线分隔，另外两块直接顶着上一块，读起来没有节奏。
 */
export default function DataPrefs() {
  const resetToday = useToday((s) => s.reset)

  const [exporting, setExporting] = useState(false)
  const [picked, setPicked] = useState<PickedFile | null>(null)
  const [importing, setImporting] = useState<ImportMode | null>(null)
  const [dataFeedback, setDataFeedback] = useState<Feedback>(null)
  /** 清释义缓存要点两次：第一次只把按钮变成「确认清空」（与词卡加词同一模式） */
  const [glossConfirming, setGlossConfirming] = useState(false)
  /** 清生成文章要点两次，且警告语气比释义缓存重（不可再生） */
  const [articleConfirming, setArticleConfirming] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleExport() {
    setExporting(true)
    setDataFeedback(null)
    try {
      const msg = await exportBackup()
      setDataFeedback({ kind: 'ok', text: msg, scope: 'export' })
    } catch (e) {
      setDataFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '导出失败',
        scope: 'export',
      })
    } finally {
      setExporting(false)
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
      const parsed = parseImportText(text)
      const existing = new Set(await listDays())
      const existingArticles = new Set((await listArticles()).map((a) => a.id))
      setPicked({
        name: file.name,
        days: parsed.days,
        articles: parsed.articles,
        newArticles: parsed.articles.filter((a) => a.id && !existingArticles.has(a.id)).length,
        notes: parsed.notes,
        existing,
      })
    } catch (e) {
      setDataFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '读取文件失败',
        scope: 'import',
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
          scope: 'import',
        })
        return
      }

      await writeDays(plan.write)
      // 文章按 id 去重后逐篇恢复（fill 语义：本地已有的不动）
      let importedArticles = 0
      for (const art of picked.articles) {
        const existingIds = new Set((await listArticles()).map((a) => a.id))
        if (!art.id || existingIds.has(art.id)) continue
        await saveArticle(art)
        importedArticles += 1
      }
      // 今天的数据可能就在这次导入里，界面上的今日页要跟着变
      await useToday.getState().loadFromStorage()

      const parts: string[] = []
      if (plan.added > 0) parts.push(`新增 ${plan.added} 天`)
      if (plan.replaced > 0) parts.push(`覆盖 ${plan.replaced} 天`)
      if (plan.kept > 0) parts.push(`保留本地 ${plan.kept} 天`)
      if (picked.articles.length > 0) parts.push(`文章 ${importedArticles} 篇`)

      setDataFeedback({ kind: 'ok', text: `导入完成：${parts.join('，')}`, scope: 'import' })
      setPicked(null)
    } catch (e) {
      setDataFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '导入失败',
        scope: 'import',
      })
    } finally {
      setImporting(null)
    }
  }

  async function handleClearAll() {
    await clearAll()
    resetToday()
    setDataFeedback({ kind: 'ok', text: '本地记录已清空', scope: 'all' })
  }

  async function handleClearArticles() {
    if (!articleConfirming) {
      setArticleConfirming(true)
      setDataFeedback(null)
      return
    }
    setArticleConfirming(false)
    try {
      const n = await clearArticles()
      setDataFeedback({
        kind: 'ok',
        text: `已清空 ${n} 篇生成文章。它们不可再生——如果还没导出备份，请先导出一份再继续使用。`,
        scope: 'articles',
      })
    } catch (e) {
      setDataFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '清空失败',
        scope: 'articles',
      })
    }
  }

  async function handleClearGloss() {
    if (!glossConfirming) {
      setGlossConfirming(true)
      setDataFeedback(null)
      return
    }
    setGlossConfirming(false)
    try {
      const n = await clearGlossCache()
      setDataFeedback({
        kind: 'ok',
        text: `已清空 ${n} 条主释义缓存。它们都能在下次点词时重新生成，自定义释义、文章与学习记录不受影响。`,
        scope: 'gloss',
      })
    } catch (e) {
      setDataFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '清空失败',
        scope: 'gloss',
      })
    }
  }

  const pickedSummary = picked ? summarize(picked.days) : null
  const conflicts = picked ? picked.days.filter((d) => picked.existing.has(d.date)).length : 0
  const freshCount = pickedSummary ? pickedSummary.count - conflicts : 0

  /** 每条提示只挂在它自己那一块下面，不跨区块串味 */
  const feedbackOf = (scope: FeedbackScope) =>
    dataFeedback && dataFeedback.scope === scope ? (
      <p className={styles.feedback} data-kind={dataFeedback.kind}>
        {dataFeedback.text}
      </p>
    ) : null

  return (
    <>
      <section className={styles.section}>
        <h2 className={styles.label}>备份与导出</h2>
        <p className={styles.about}>
          记录只存在这台设备上。换手机或重装前，先导出一份备份：学习记录、生成文章、
          阅读时长、自定义释义、训练成绩都在里面。
        </p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void handleExport()}
            disabled={exporting}
          >
            {exporting ? '导出中…' : '导出备份'}
          </button>
        </div>

        <p className={styles.help}>
          「导出备份」是 JSON，能原样导回。它是唯一的导出格式 —— 之前的 CSV / Markdown
          只有日期和单词，导回来会丢学习时长与逐词反馈，已经去掉。
        </p>

        {feedbackOf('export')}

        <p className={styles.warnNote}>
          提示：备份与导出功能仍建议留两份（例如同时存在网盘与本机）。导出的文件包含
          全部个人数据，分享前请确认收件人。
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.label}>导入</h2>
        <p className={styles.about}>
          从「导出备份」的 JSON 恢复。学习记录可选「只补缺失」或「覆盖同一天」；
          文章、阅读时长、自定义释义、训练成绩按各自的规则合并（见预览里的说明）。
        </p>

        <input
          ref={fileRef}
          type="file"
          className={styles.fileInput}
          // 带上 octet-stream：部分 ROM 把 .json 认成未知类型，只按 application/json
          // 过滤会让用户自己的备份文件在选择器里变灰
          accept=".json,application/json,application/octet-stream"
          onChange={(e) => void handlePickFile(e)}
        />

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => fileRef.current?.click()}
            disabled={importing !== null}
          >
            {picked ? '换一个文件…' : '选择文件…'}
          </button>
        </div>

        {picked && pickedSummary && (
          <div className={styles.preview}>
            <p className={styles.previewName}>{picked.name}</p>
            <p className={styles.previewMeta}>
              备份 · {pickedSummary.count} 天 · {pickedSummary.words} 个词
            </p>
            <p className={styles.previewMeta}>
              {pickedSummary.first} — {pickedSummary.last}
            </p>

            {picked.articles.length > 0 && (
              <p className={styles.previewMeta}>
                备份含生成文章 {picked.articles.length} 篇
                {picked.articles.length - picked.newArticles > 0
                  ? `（本地已有 ${picked.articles.length - picked.newArticles} 篇，导入时跳过）`
                  : '（全部为新增）'}
              </p>
            )}

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

        {feedbackOf('import')}
      </section>

      <section className={styles.section}>
        <h2 className={styles.label}>生成文章</h2>
        <p className={styles.about}>
          生成的文章存在本机，且<strong>不在自动备份的内容里</strong>——换手机前请务必先点「导出备份」
          （备份已包含文章全文），再清空或卸载。
        </p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void handleClearArticles()}
          >
            {articleConfirming ? '确认清空全部生成文章？' : '清空生成文章'}
          </button>
        </div>

        {feedbackOf('articles')}
      </section>

      <section className={styles.section}>
        <h2 className={styles.label}>释义缓存</h2>
        <p className={styles.about}>
          点词查过的主释义会一直留着，存在本机的释义文件里。清空后文章与学习记录不受影响，
          释义在下次点词时按需重新生成。<strong>你自己填的、AI 补的备选释义不会被清掉。</strong>
        </p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void handleClearGloss()}
          >
            {glossConfirming ? '确认清空释义缓存？' : '清空释义缓存'}
          </button>
        </div>

        {feedbackOf('gloss')}
      </section>

      <section className={styles.section}>
        <h2 className={styles.label}>全部记录</h2>
        <p className={styles.about}>
          删除本机保存的每日学习记录与阅读时长，不可恢复。生成文章、释义缓存与训练成绩不在此列，
          需要在上面对应区块单独清空。
        </p>

        <button type="button" className={styles.danger} onClick={() => void handleClearAll()}>
          清空全部记录
        </button>
        {feedbackOf('all')}
      </section>
    </>
  )
}
