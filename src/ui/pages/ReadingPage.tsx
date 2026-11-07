import { useCallback, useEffect, useMemo, useState } from 'react'
import { Preferences } from '@capacitor/preferences'

import { getAllDays, getDay } from '@/data/store'
import {
  getArticleById,
  getCoveredWordsToday,
  getLatestArticleOfDay,
  listArticles,
  saveArticle,
  type ArticleMeta,
} from '@/data/article'
import { lemmaCandidates } from '@/data/dict'
import {
  generateArticle,
  missingWords,
  pickWords,
  wordCount,
  LEVEL_LABEL,
  MAX_TARGET_WORDS,
  MODE_HINT,
  MODE_LABEL,
  type Article,
  type ArticleLevel,
  type ArticleMode,
} from '@/domain/article'
import { dateKey, monthDay } from '@/lib/date'
import { useLlm } from '@/store/llm'
import type { TodaySnapshot } from '@/domain/collect'

import WordSheet from '../components/WordSheet'
import styles from './ReadingPage.module.css'

type Props = {
  onGoSettings: () => void
}

type FontSize = 's' | 'm' | 'l' | 'xl'

const MODES: ArticleMode[] = ['weak', 'new', 'all']
const LEVELS: ArticleLevel[] = ['cet4', 'cet6', 'kaoyan', 'ielts']

const FONT_SIZES: { key: FontSize; label: string }[] = [
  { key: 's', label: '小' },
  { key: 'm', label: '标准' },
  { key: 'l', label: '大' },
  { key: 'xl', label: '特大' },
]

/** 一篇文章覆盖多少个目标词，可调 */
const WORD_LIMITS = [10, 15, 20, 25, 30]

const FONT_KEY = 'reading_font_size'
const LIMIT_KEY = 'reading_word_limit'

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
  const hasModel = useLlm((s) => s.profiles.length > 0)
  const llmReady = useLlm((s) => s.ready)

  const [article, setArticle] = useState<Article | null>(null)
  const [library, setLibrary] = useState<ArticleMeta[]>([])
  const [mode, setMode] = useState<ArticleMode>('weak')
  const [level, setLevel] = useState<ArticleLevel>('kaoyan')
  const [wordLimit, setWordLimit] = useState(MAX_TARGET_WORDS)
  const [showZh, setShowZh] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [sheetWord, setSheetWord] = useState<string | null>(null)

  const [fontSize, setFontSize] = useState<FontSize>('m')
  const [sizePanel, setSizePanel] = useState(false)
  const [pastOpen, setPastOpen] = useState(false)
  const [showSetup, setShowSetup] = useState(false)
  const [pool, setPool] = useState<TodaySnapshot[]>([])

  const today = dateKey()

  const available = useMemo(
    () => (pool.length > 0 ? pickWords(pool, mode, 999).length : null),
    [pool, mode],
  )

  const refreshLibrary = useCallback(async () => {
    setLibrary(await listArticles())
  }, [])

  useEffect(() => {
    void (async () => {
      const latest = await getLatestArticleOfDay(today)
      if (latest) setArticle(latest)
      await refreshLibrary()

      const [font, limit] = await Promise.all([
        Preferences.get({ key: FONT_KEY }),
        Preferences.get({ key: LIMIT_KEY }),
      ])
      if (font.value === 's' || font.value === 'l' || font.value === 'xl') {
        setFontSize(font.value)
      }
      const parsedLimit = Number(limit.value)
      if (WORD_LIMITS.includes(parsedLimit)) setWordLimit(parsedLimit)

      const all = await getAllDays()
      const snap = await getDay(today)
      const merged = snap ? [snap, ...all.filter((d) => d.date !== today)] : all
      setPool(merged.slice(0, 7))
    })()
  }, [today, refreshLibrary])

  const targetSet = useMemo(
    () => new Set(article?.targetWords.map((w) => w.toLowerCase()) ?? []),
    [article],
  )

  const isTargetWord = useCallback(
    (word: string) => lemmaCandidates(word).some((c) => targetSet.has(c)),
    [targetSet],
  )

  async function changeFontSize(next: FontSize) {
    setFontSize(next)
    await Preferences.set({ key: FONT_KEY, value: next })
  }

  async function changeWordLimit(next: number) {
    setWordLimit(next)
    await Preferences.set({ key: LIMIT_KEY, value: String(next) })
  }

  async function handleGenerate() {
    if (!hasModel) {
      setError('还没有配置大模型。去设置里填一个 API Key，智谱的免费。')
      return
    }

    setBusy(true)
    setError(null)
    setMissing([])

    try {
      let source = pool
      if (source.length === 0) {
        const all = await getAllDays()
        const snap = await getDay(today)
        source = (snap ? [snap, ...all.filter((d) => d.date !== today)] : all).slice(0, 7)
        setPool(source)
      }

      // 只排除「今天」已经生成过的词：
      // 到了第二天，之前忘过的词会重新回到候选里，可以再复习一遍。
      const covered = await getCoveredWordsToday(today)

      let words = pickWords(source, mode, wordLimit, covered)
      if (words.length < Math.min(8, wordLimit)) {
        words = pickWords(source, mode, wordLimit)
      }
      if (words.length === 0) {
        throw new Error('这个范围里没有可用的词。先去背几个单词，或者换个生成范围。')
      }

      const draft = await generateArticle({ words, mode, level, date: today })
      const saved = await saveArticle(draft)

      setArticle(saved)
      setShowZh(false)
      setShowSetup(false)
      setMissing(missingWords(saved))
      await refreshLibrary()
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  async function handleOpen(id: string) {
    const a = await getArticleById(id)
    if (!a) return
    setArticle(a)
    setShowZh(false)
    setMissing([])
    setPastOpen(false)
  }

  const hasArticle = Boolean(article)

  return (
    <div className={styles.page} data-size={fontSize}>
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
              data-on={sizePanel}
              onClick={() => setSizePanel((v) => !v)}
            >
              字号
            </button>
            <button
              type="button"
              className={styles.action}
              data-on={showSetup}
              onClick={() => setShowSetup((v) => !v)}
            >
              {busy ? '生成中' : '生成'}
            </button>
          </div>
        )}
      </header>

      {sizePanel && (
        <div className={styles.sizePanel}>
          {FONT_SIZES.map((f) => (
            <button
              key={f.key}
              type="button"
              className={styles.segment}
              data-on={fontSize === f.key}
              onClick={() => void changeFontSize(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {library.length > 0 && (
        <div className={styles.pastBar}>
          <button
            type="button"
            className={styles.pastToggle}
            onClick={() => setPastOpen((v) => !v)}
            aria-expanded={pastOpen}
          >
            <span>文章库 · {library.length} 篇</span>
            <span className={styles.caret} data-open={pastOpen}>
              ⌄
            </span>
          </button>

          {pastOpen && (
            <ul className={styles.pastList}>
              {library.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    className={styles.pastItem}
                    data-current={h.id === article?.id}
                    onClick={() => void handleOpen(h.id)}
                  >
                    <span className={styles.pastDate}>{monthDay(h.date)}</span>
                    <span className={styles.pastTitle}>{h.title}</span>
                    <span className={styles.pastCount}>{h.wordCount}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!llmReady && null}

      {llmReady && !hasModel && (
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

      {hasModel && (showSetup || !hasArticle) && (
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
            <p className={styles.fieldHint}>
              {MODE_HINT[mode]}
              {available !== null &&
                (available > wordLimit
                  ? ` · 有 ${available} 个可选，本篇取前 ${wordLimit} 个`
                  : ` · 共 ${available} 个，全部用上`)}
            </p>
          </div>

          <div className={styles.field}>
            <h2 className={styles.fieldLabel}>覆盖词数</h2>
            <div className={styles.segments}>
              {WORD_LIMITS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={styles.segment}
                  data-on={wordLimit === n}
                  onClick={() => void changeWordLimit(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className={styles.fieldHint}>
              一篇文章里塞太多会变成词表，30 个已是上限。
            </p>
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
            {busy ? '正在生成…' : hasArticle ? '再生成一篇' : '生成一篇文章'}
          </button>

          {busy && <p className={`${styles.hint} loading-pulse`}>先列提纲，再成文，通常 20~50 秒。</p>}
        </section>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {hasArticle && article && (
        <>
          <article className={styles.article}>
            <h2 className={styles.articleTitle}>{article.title}</h2>
            {showZh && article.titleZh && (
              <p className={styles.titleZh}>{article.titleZh}</p>
            )}

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
        </>
      )}

      {sheetWord && <WordSheet word={sheetWord} onClose={() => setSheetWord(null)} />}
    </div>
  )
}
