import { useEffect, useState } from 'react'

import type { GlossSource } from '../../hooks/useGlossSource'

import styles from '../WordSheet.module.css'

/**
 * 词卡的释义区：主释义、AI 备选、自定义释义（含编辑态）。
 *
 * 只做展示与编辑态，数据来源仍在 `useGlossSource`（父层持有，因为变形族要用主释义）。
 * 原先这一整块与墨墨面板、遮罩动画挤在同一个组件里，改样式很容易碰到确认态的时机。
 */
export default function GlossPanel({
  word,
  source,
  mainText,
  mainTag,
  customRow,
  altAi,
  custom,
}: {
  /** 当前查的词（短语视图下是短语本身），换词时收起编辑框 */
  word: string
  source: GlossSource
  /** 主释义（自定义兜底已合并进来） */
  mainText: string | null
  /** 主释义的来源标记：自定义 / AI 释义 / 空 */
  mainTag: string
  /** 与主释义不同的那条自定义释义（相同就不重复显示） */
  customRow: string
  altAi: string | undefined
  custom: string | undefined
}) {
  /** 自定义释义的编辑态：只在点「自定义」时打开 */
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  // 换词就收起编辑框，别让上一个词的草稿留在这里
  useEffect(() => {
    setEditing(false)
    setDraft('')
  }, [word])

  async function save() {
    await source.saveCustom(draft)
    setEditing(false)
    setDraft('')
  }

  return (
    <>
      <p className={styles.gloss}>
        {source.loading ? (
          '查询中…'
        ) : (
          <>
            {mainText || '没有查到这个词的释义'}
            {mainTag && (
              <span className={styles.aiTag} data-testid="main-tag">
                {mainTag}
              </span>
            )}
          </>
        )}
      </p>

      {/*
        主释义永远在上面；AI 与自定义各占一行，**有内容才出现**。
        主释义本身就是 AI 给的时候（本地没收录、由 AI 兜底），不再单独占一行 ——
        那会和上面一字不差。
      */}
      {!source.loading && (
        <>
          {altAi && (
            <div className={styles.altRow}>
              <span className={styles.altLabel}>AI 释义</span>
              <span className={styles.altText} data-testid="alt-ai">
                {altAi}
              </span>
              <span className={styles.altActions}>
                <button
                  type="button"
                  className={styles.altAction}
                  onClick={() => void source.requestAi()}
                  disabled={source.aiBusy}
                >
                  {source.aiBusy ? '生成中…' : '重新生成'}
                </button>
                <button
                  type="button"
                  className={styles.altAction}
                  data-testid="drop-ai"
                  onClick={() => void source.dropAi()}
                >
                  删除
                </button>
              </span>
            </div>
          )}

          {customRow && !editing && (
            <div className={styles.altRow}>
              <span className={styles.altLabel}>自定义</span>
              <span className={styles.altText} data-testid="alt-custom">
                {customRow}
              </span>
              <span className={styles.altActions}>
                <button
                  type="button"
                  className={styles.altAction}
                  data-testid="edit-custom"
                  onClick={() => {
                    setDraft(customRow)
                    setEditing(true)
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className={styles.altAction}
                  data-testid="drop-custom"
                  onClick={() => void source.dropCustom()}
                >
                  删除
                </button>
              </span>
            </div>
          )}

          {editing && (
            <div className={styles.editor}>
              <textarea
                className={styles.editorInput}
                data-testid="custom-input"
                value={draft}
                rows={2}
                maxLength={200}
                placeholder="写下你自己对这一条的理解"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className={styles.editorActions}>
                <button
                  type="button"
                  className={styles.altAction}
                  onClick={() => {
                    setEditing(false)
                    setDraft('')
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={styles.altAction}
                  data-testid="save-custom"
                  onClick={() => void save()}
                >
                  保存
                </button>
              </div>
            </div>
          )}

          {/* 某一项还没有内容时，给一个入口；两项都齐了就不占位置 */}
          {!editing && (!altAi || !customRow) && (
            <div className={styles.entryRow}>
              {!altAi && (
                <button
                  type="button"
                  className={styles.entryBtn}
                  data-testid="ask-ai"
                  onClick={() => void source.requestAi()}
                  disabled={source.aiBusy || !source.hasModel}
                >
                  {source.aiBusy ? '生成中…' : source.ai ? '重新生成 AI 释义' : 'AI 释义'}
                </button>
              )}
              {!customRow && (
                <button
                  type="button"
                  className={styles.entryBtn}
                  data-testid="add-custom"
                  onClick={() => {
                    setDraft(custom ?? '')
                    setEditing(true)
                  }}
                >
                  {custom ? '编辑释义' : '自定义释义'}
                </button>
              )}
            </div>
          )}

          {source.aiNotice && <p className={styles.altNotice}>{source.aiNotice}</p>}
          {!source.hasModel && !altAi && (
            <p className={styles.altNotice}>AI 释义要先用设置里配置的大模型</p>
          )}
        </>
      )}
    </>
  )
}
