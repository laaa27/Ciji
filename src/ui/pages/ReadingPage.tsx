import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Preferences } from '@capacitor/preferences'

import { listDays } from '@/data/store'
import {
  deleteArticle,
  getArticleById,
  getLatestArticleOfDay,
  listArticles,
  saveArticle,
  type ArticleMeta,
} from '@/data/article'
import { lemmaCandidates } from '@/data/dict'
import {
  generateArticle,
  missingWords,
  wordCount,
  LEVEL_LABEL,
  MAX_TARGET_WORDS,
  type Article,
  type ArticleLevel,
} from '@/domain/article'
import { dateKey, monthDay } from '@/lib/date'
import { getLastLlmResponse } from '@/api/llm'
import { pushBackHandler } from '@/store/backstack'
import { useToast } from '@/store/toast'
import { useLlm } from '@/store/llm'

import { findScrollParent, useScrollStuck } from '../hooks/useScrollStuck'
import ArticleLibrary from '../components/ArticleLibrary'
import GenerateArticle, { type GenerateRequest } from '../components/GenerateArticle'
import WordSheet from '../components/WordSheet'
import styles from './ReadingPage.module.css'

type Props = {
  onGoSettings: () => void
  /** 当前是否停留在阅读栏目。生成完成时用它决定要不要弹提示 */
  active: boolean
}

type FontSize = 's' | 'm' | 'l' | 'xl'

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
const LEVEL_KEY = 'reading_level'

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

export default function ReadingPage({ onGoSettings, active }: Props) {
  // 生成是异步的，完成那一刻的 active 才是准的（过程中用户可能已经切走）
  const activeRef = useRef(active)
  activeRef.current = active

  const hasModel = useLlm((s) => s.profiles.length > 0)
  const llmReady = useLlm((s) => s.ready)

  const [article, setArticle] = useState<Article | null>(null)
  const [library, setLibrary] = useState<ArticleMeta[]>([])
  const [level, setLevel] = useState<ArticleLevel>('kaoyan')
  const [wordLimit, setWordLimit] = useState(MAX_TARGET_WORDS)
  const [showZh, setShowZh] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [sheetWord, setSheetWord] = useState<string | null>(null)

  const [fontSize, setFontSize] = useState<FontSize>('m')
  const [sizePanel, setSizePanel] = useState(false)
  /** 是否停在文章库子视图 */
  const [libOpen, setLibOpen] = useState(false)
  /** 是否停在生成文章子视图 */
  const [genOpen, setGenOpen] = useState(false)
  /** 有学习记录的日期（倒序），给生成页的日期选择用 */
  const [days, setDays] = useState<string[]>([])
  /** 刚从文章库返回：给阅读页放一次入场动画，免得像被「刷」地换掉 */
  const [returning, setReturning] = useState(false)

  const headerRef = useRef<HTMLElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  /** 打开文章库之前的阅读位置，返回时原地恢复 */
  const articleScroll = useRef(0)
  const headerStuck = useScrollStuck(headerRef)

  const today = dateKey()

  const refreshLibrary = useCallback(async () => {
    setLibrary(await listArticles())
  }, [])

  useEffect(() => {
    void (async () => {
      const latest = await getLatestArticleOfDay(today)
      if (latest) setArticle(latest)
      await refreshLibrary()

      const [font, limit, lv] = await Promise.all([
        Preferences.get({ key: FONT_KEY }),
        Preferences.get({ key: LIMIT_KEY }),
        Preferences.get({ key: LEVEL_KEY }),
      ])
      if (font.value === 's' || font.value === 'l' || font.value === 'xl') {
        setFontSize(font.value)
      }
      const parsedLimit = Number(limit.value)
      if (WORD_LIMITS.includes(parsedLimit)) setWordLimit(parsedLimit)
      if (lv.value === 'cet4' || lv.value === 'cet6' || lv.value === 'kaoyan') {
        setLevel(lv.value)
      }

      setDays(await listDays())
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

  async function handleGenerate(req: GenerateRequest) {
    if (!hasModel) {
      setError('还没有配置大模型。去设置里填一个 API Key，智谱的免费。')
      return
    }
    if (req.words.length === 0) {
      setError('没有选中任何单词')
      return
    }

    setBusy(true)
    setError(null)
    setMissing([])

    try {
      const draft = await generateArticle({
        words: req.words,
        kinds: req.kinds,
        level: req.level,
        date: req.date,
      })
      const saved = await saveArticle(draft)

      setArticle(saved)
      setShowZh(false)
      setMissing(missingWords(saved))
      await refreshLibrary()

      closeGenerate()

      // 用户已经切到别的栏目了，得让他知道文章好了
      if (!activeRef.current) useToast.getState().show('文章生成好了')
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
    closeLibrary()
  }

  const closeLibrary = useCallback(() => {
    setLibOpen(false)
    setReturning(true)
    window.setTimeout(() => setReturning(false), 320)
  }, [])

  // 安卓返回键：在文章库里先回阅读页
  useEffect(() => {
    if (!libOpen) return
    return pushBackHandler(closeLibrary)
  }, [libOpen, closeLibrary])

  // 词卡也是子视图，返回键先关它
  useEffect(() => {
    if (!sheetWord) return
    return pushBackHandler(() => setSheetWord(null))
  }, [sheetWord])

  function rememberScroll() {
    const scroller = findScrollParent(pageRef.current)
    if (scroller) articleScroll.current = scroller.scrollTop
  }

  function openLibrary() {
    rememberScroll()
    setLibOpen(true)
  }

  const closeGenerate = useCallback(() => {
    setGenOpen(false)
    setReturning(true)
    window.setTimeout(() => setReturning(false), 320)
  }, [])

  async function openGenerate() {
    rememberScroll()
    // 日期可能变了（比如过了零点又学了新词），每次进来重读一次
    setDays(await listDays())
    setError(null)
    setGenOpen(true)
  }

  // 安卓返回键：在生成页里先回阅读页
  useEffect(() => {
    if (!genOpen) return
    return pushBackHandler(closeGenerate)
  }, [genOpen, closeGenerate])

  async function handleDeleteArticle(id: string) {
    const wasOpen = article?.id === id
    await deleteArticle(id)
    await refreshLibrary()

    if (!wasOpen) return

    // 删掉的正是当前打开的那篇：换成剩下最新的一篇（不限当天），没有就清空
    const remaining = await listArticles()
    const next = remaining[0] ? await getArticleById(remaining[0].id) : null
    setArticle(next)
    setShowZh(false)
    setMissing(next ? missingWords(next) : [])
  }

  // 进出子视图时重置/恢复滚动：库页从顶部看，返回时回到刚才读到的地方
  useEffect(() => {
    const scroller = findScrollParent(pageRef.current)
    if (!scroller) return

    if (libOpen || genOpen) {
      scroller.scrollTop = 0
      return
    }
    const raf = requestAnimationFrame(() => {
      scroller.scrollTop = articleScroll.current
    })
    return () => cancelAnimationFrame(raf)
  }, [libOpen, genOpen])

  const hasArticle = Boolean(article)

  if (genOpen) {
    return (
      <div className={styles.page} data-size={fontSize} data-view="gen" ref={pageRef}>
        <GenerateArticle
          days={days}
          today={today}
          initialLevel={level}
          initialLimit={wordLimit}
          busy={busy}
          error={error}
          onBack={closeGenerate}
          onGenerate={handleGenerate}
          onLevelChange={(next) => {
            setLevel(next)
            void Preferences.set({ key: LEVEL_KEY, value: next })
          }}
          onLimitChange={(next) => void changeWordLimit(next)}
        />
      </div>
    )
  }

  if (libOpen) {
    return (
      <div className={styles.page} data-size={fontSize} data-view="lib" ref={pageRef}>
        <ArticleLibrary
          items={library}
          currentId={article?.id}
          onBack={closeLibrary}
          onOpen={(id) => void handleOpen(id)}
          onDelete={handleDeleteArticle}
        />
      </div>
    )
  }

  return (
    <div
      className={styles.page}
      data-size={fontSize}
      data-return={returning ? 'true' : 'false'}
      ref={pageRef}
    >
      <header
        className={styles.header}
        ref={headerRef}
        data-stuck={headerStuck ? 'true' : 'false'}
      >
        <h1 className={styles.title}>阅读</h1>

        <div className={styles.actions}>
          {hasArticle && (
            <>
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
            </>
          )}
          {hasModel && (
            <button type="button" className={styles.action} onClick={() => void openGenerate()}>
              {busy ? '生成中' : '生成'}
            </button>
          )}
          {library.length > 0 && (
            <button type="button" className={styles.action} onClick={openLibrary}>
              文章库
            </button>
          )}
        </div>
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

      {hasModel && !hasArticle && (
        <div className={styles.notice}>
          <p className={styles.noticeTitle}>还没有文章</p>
          <p className={styles.noticeText}>
            挑一天学过的词，生成一篇短文，让忘记的词再遇见一次。
          </p>
          <button type="button" className={styles.primary} onClick={() => void openGenerate()}>
            去选词
          </button>
        </div>
      )}

      {error && (
        <div className={styles.error}>
          <p>{error}</p>
          {/* 生成失败时把模型到底返回了什么露出来，否则只能靠猜 */}
          {getLastLlmResponse() && (
            <details className={styles.rawBox}>
              <summary>查看模型原始响应</summary>
              <pre>{getLastLlmResponse()?.slice(0, 1200)}</pre>
            </details>
          )}
        </div>
      )}

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
