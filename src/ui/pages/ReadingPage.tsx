import { useCallback, useEffect, useMemo, useState } from 'react'

import { getAllDays, getDay } from '@/data/store'
import { getAllArticles, getArticle, saveArticle } from '@/data/article'
import { lemmaCandidates } from '@/data/dict'
import {
  generateArticle,
  missingWords,
  pickWords,
  wordCount,
  LEVEL_LABEL,
  MODE_HINT,
  MODE_LABEL,
  type Article,
  type ArticleLevel,
  type ArticleMode,
} from '@/domain/article'
import { dateKey, monthDay } from '@/lib/date'
import { useLlm } from '@/store/llm'

import WordSheet from '../components/WordSheet'
import styles from './ReadingPage.module.css'

type Props = {
  onGoSettings: () => void
}

type Summary = { date: string; title: string; wordCount: number }

const MODES: ArticleMode[] = ['weak', 'new', 'all']
const LEVELS: ArticleLevel[] = ['cet4', 'cet6', 'kaoyan', 'ielts']

/** 按单词切分句子，保留标点和空格 */
function tokenize(sentence: string): { text: string; isWord: boolean }[] {
  const parts: { text: string; isWord: boolean }[] = []
  const re = /[A-Za-z][A-Za-z'-]*/g
  let last = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(sentence)) !== null) {
    if (m.index > last) parts.push({ text: sentence.slice(last, m.index), isWord: false })
    parts.push({ text: m[0], isWord: true })
    last = m.index + m[0].length
  }
  if (last < sentence.length) parts.push({ text: sentence.slice(last), isWord: false })

  return parts
}

export default function ReadingPage({ onGoSettings }: Props) {
  const apiKey = useLlm((s) => s.apiKey)
  const llmReady = useLlm((s) => s.ready)

  const [article, setArticle] = useState<Article | null>(null)
  const [history, setHistory] = useState<Summary[]>([])
  const [mode, setMode] = useState<ArticleMode>('weak')
  const [level, setLevel] = useState<ArticleLevel>('kaoyan')
  const [showZh, setShowZh] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [sheetWord, setSheetWord] = useState<string | null>(null)

  const today = dateKey()

  const refreshHistory = useCallback(async () => {
    const list = await getAllArticles()
    setHistory(
      list.map((a) => ({
        date: a.date,
        title: a.title,
        wordCount: a.sentences.reduce(
          (n, s) => n + (s.en.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0),
          0,
        ),
      })),
    )
  }, [])

  useEffect(() => {
    void (async () => {
      const todayArticle = await getArticle(today)
      if (todayArticle) setArticle(todayArticle)
      await refreshHistory()
    })()
  }, [today, refreshHistory])

  const targetSet = useMemo(
    () => new Set(article?.targetWords.map((w) => w.toLowerCase()) ?? []),
    [article],
  )

  const isTargetWord = useCallback(
    (word: string) => lemmaCandidates(word).some((c) => targetSet.has(c)),
    [targetSet],
  )

  async function handleGenerate() {
    if (!apiKey) {
      setError('还没有配置大模型。去设置里填一个 API Key，智谱的免费。')
      return
    }

    setBusy(true)
    setError(null)
    setMissing([])

    try {
      const all = await getAllDays()
      const todaySnap = await getDay(today)
      const pool = todaySnap ? [todaySnap, ...all.filter((d) => d.date !== today)] : all

      const words = pickWords(pool.slice(0, 7), mode)
      if (words.length === 0) {
        throw new Error('这个范围里没有可用的词。先去背几个单词，或者换个生成范围。')
      }

      const next = await generateArticle({ words, mode, level, date: today })
      await saveArticle(next)
      setArticle(next)
      setShowZh(false)
      setMissing(missingWords(next))
      await refreshHistory()
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  async function handleOpenPast(date: string) {
    const a = await getArticle(date)
    if (!a) return
    setArticle(a)
    setShowZh(false)
    setMissing([])
  }

  const hasArticle = Boolean(article)
  const past = history.filter((h) => h.date !== article?.date)

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>阅读</h1>

        {hasArticle && (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.action}
              data-on={showZh}
              onClick={() => setShowZh((v) => !v)}
            >
              译文
            </button>
            <button
              type="button"
              className={styles.action}
              onClick={() => void handleGenerate()}
              disabled={busy}
            >
              {busy ? '重写中' : '重写'}
            </button>
          </div>
        )}
      </header>

      {!llmReady && null}

      {llmReady && !apiKey && (
        <div className={styles.notice}>
          <p className={styles.noticeTitle}>还没有配置大模型</p>
          <p className={styles.noticeText}>
            生成文章需要一个模型服务。智谱的 GLM-4-Flash 免费，注册后把 API Key 填进设置即可。
          </p>
          <button type="button" className={styles.primary} onClick={onGoSettings}>
            去设置
          </button>
        </div>
      )}

      {apiKey && !hasArticle && (
        <section className={styles.setup}>
          <div className={styles.field}>
            <h2 className={styles.fieldLabel}>用哪些词</h2>
            <div className={styles.segments}>
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={styles.segment}
                  data-on={mode === m}
                  onClick={() => setMode(m)}
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <p className={styles.fieldHint}>{MODE_HINT[mode]}</p>
          </div>

          <div className={styles.field}>
            <h2 className={styles.fieldLabel}>难度</h2>
            <div className={styles.segments}>
              {LEVELS.map((l) => (
                <button
                  key={l}
                  type="button"
                  className={styles.segment}
                  data-on={level === l}
                  onClick={() => setLevel(l)}
                >
                  {LEVEL_LABEL[l]}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            className={styles.primary}
            onClick={() => void handleGenerate()}
            disabled={busy}
          >
            {busy ? '正在生成…' : '生成一篇文章'}
          </button>

          {busy && <p className={styles.hint}>模型正在组织段落，通常 10~30 秒。</p>}
        </section>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {hasArticle && article && (
        <>
          <article className={styles.article}>
            <h2 className={styles.articleTitle}>{article.title}</h2>

            <div className={styles.meta}>
              {monthDay(article.date)} · {wordCount(article)} 词 · {LEVEL_LABEL[article.level]}
            </div>

            <div className={styles.body}>
              {article.sentences.map((s, i) => (
                <div
                  key={i}
                  className={styles.sentence}
                  data-break={(i + 1) % 4 === 0 && i !== article.sentences.length - 1}
                >
                  <p className={styles.en}>
                    {tokenize(s.en).map((part, j) =>
                      part.isWord ? (
                        <button
                          key={j}
                          type="button"
                          className={styles.word}
                          data-target={isTargetWord(part.text)}
                          onClick={() => setSheetWord(part.text)}
                        >
                          {part.text}
                        </button>
                      ) : (
                        <span key={j}>{part.text}</span>
                      ),
                    )}
                  </p>
                  {showZh && s.zh && <p className={styles.zh}>{s.zh}</p>}
                </div>
              ))}
            </div>
          </article>

          {missing.length > 0 && (
            <p className={styles.warn}>
              有 {missing.length} 个词没能写进文章：{missing.join('、')}
            </p>
          )}

          <p className={styles.coverage}>
            本篇覆盖 {article.targetWords.length} 个词 · 由 {article.model} 生成
          </p>

          {past.length > 0 && (
            <section className={styles.past}>
              <h2 className={styles.fieldLabel}>往期</h2>
              <ul>
                {past.map((h) => (
                  <li key={h.date}>
                    <button
                      type="button"
                      className={styles.pastItem}
                      onClick={() => void handleOpenPast(h.date)}
                    >
                      <span className={styles.pastDate}>{monthDay(h.date)}</span>
                      <span className={styles.pastTitle}>{h.title}</span>
                      <span className={styles.pastCount}>{h.wordCount}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {sheetWord && <WordSheet word={sheetWord} onClose={() => setSheetWord(null)} />}
    </div>
  )
}
