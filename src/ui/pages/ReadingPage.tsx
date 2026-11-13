import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
import { lookupKnownPhrases } from '@/domain/memo'
import { findPhraseAround, phraseCandidates, phraseVariants, type PhraseHit } from '@/domain/phrase'
import {
  articleToText,
  generateArticle,
  missingWords,
  wordCount,
  LEVEL_LABEL,
  GENRE_LABEL,
  type Article,
  type ArticleSentence,
  type GenProgress,
} from '@/domain/article'
import { copyText } from '@/lib/clipboard'
import { dateKey, monthDay } from '@/lib/date'
import { restoreScroll } from '@/lib/scroll'
import { wordPattern } from '@/lib/text'
import { getLastLlmResponse } from '@/api/llm'
import { pushBackHandler } from '@/store/backstack'
import { useToast } from '@/store/toast'
import { clearGenDraft, clearReadPos, readReadPos, readShowZh, saveReadPos, saveShowZh } from '@/store/ui'
import { useLlm } from '@/store/llm'
import { usePrefs, type FontSize } from '@/store/prefs'
import { useSession } from '@/store/session'

import { findScrollParent, useScrollStuck } from '../hooks/useScrollStuck'
import { useReadingClock } from '../hooks/useReadingClock'
import { useSubView } from '../hooks/useSubView'
import ArticleLibrary from '../components/ArticleLibrary'
import GenerateArticle, { type GenerateRequest } from '../components/GenerateArticle'
import WordSheet from '../components/WordSheet'
import styles from './ReadingPage.module.css'

type Props = {
  onGoSettings: () => void
  /** 当前是否停留在阅读栏目。生成完成时用它决定要不要弹提示 */
  active: boolean
}

const FONT_SIZES: { key: FontSize; label: string }[] = [
  { key: 's', label: '小' },
  { key: 'm', label: '标准' },
  { key: 'l', label: '大' },
  { key: 'xl', label: '特大' },
]

/**
 * 每段几句。
 *
 * 模型返回的是逐句数组，没有段落信息 —— 所以段落只能按固定句数切。
 * 段内句子连排（读起来是连续的一段文字），段与段之间才留白。
 */
const SENTENCES_PER_PARA = 4

/** 把秒数排成 05:24 / 1:02:03 这样的表盘格式 */
function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * 按单词切分句子，保留标点和空格。
 *
 * `tail` 是紧跟在单词后面、中间没有空格的标点（`shop.` 的那个句点）。
 * 它要跟单词一起渲染成一个不可断的整体 —— 否则浏览器会在 button（inline-block）
 * 和标点之间断行，句号就孤零零掉到下一行去。
 */
function tokenize(sentence: string): { text: string; tail: string; isWord: boolean }[] {
  const parts: { text: string; tail: string; isWord: boolean }[] = []
  const re = wordPattern()
  let last = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(sentence)) !== null) {
    if (m.index > last) parts.push({ text: sentence.slice(last, m.index), tail: '', isWord: false })

    let end = m.index + m[0].length
    // 只吃「非空白」的尾巴：逗号后的空格必须留在外面，不然下一句会和这个词粘死
    const glued = /^[^\sA-Za-z]+/.exec(sentence.slice(end))
    const tail = glued ? glued[0] : ''
    end += tail.length

    parts.push({ text: m[0], tail, isWord: true })
    last = end
  }
  if (last < sentence.length) parts.push({ text: sentence.slice(last), tail: '', isWord: false })

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
  /** 字号 / 词数上限 / 难度：统一走偏好层，不再各自 useState + 落盘 */
  const level = usePrefs((s) => s.readingLevel)
  const wordLimit = usePrefs((s) => s.readingLimit)
  /** 译文开关：从本地同步读，重启后保持一致（否则高度变了、阅读位置就错） */
  const [showZh, setShowZhState] = useState(readShowZh)
  const setShowZh = (next: boolean) => {
    setShowZhState(next)
    saveShowZh(next)
  }
  const [busy, setBusy] = useState(false)
  /** 生成阶段（提纲 / 成文 / 重写 / 保存），给生成页那个"现在在干嘛"用 */
  const [genStage, setGenStage] = useState<GenProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [sheetWord, setSheetWord] = useState<string | null>(null)
  /** 点词后在上下文里匹配到的固定搭配；到货后弹层会自动切到短语视图 */
  const [sheetPhrase, setSheetPhrase] = useState<PhraseHit | null>(null)
  /** 防止上一次匹配的结果盖到刚点的另一个词上 */
  const phraseForRef = useRef('')

  /**
   * 点词：立即按单词打开（本地词典通常在缓存里，几乎是瞬时的），
   * 同时在这个位置找固定搭配；找到了弹层再补一个「短语」视图。
   * 两段式是为了不让"匹配短语"拖慢本来很快的单词查询。
   */
  const openWord = (parts: { text: string; isWord: boolean }[], j: number) => {
    const word = parts[j].text
    phraseForRef.current = word
    setSheetPhrase(null)
    setSheetWord(word)

    void (async () => {
      // 快路径：本地词典命中就不用发请求
      const local = await findPhraseAround(parts, j)
      if (phraseForRef.current !== word) return
      if (local) {
        setSheetPhrase(local)
        return
      }

      // 慢路径：本地没有就问墨墨（实测同样是 20 个高频搭配，本地命中 7 个、墨墨 14 个）
      // 查询串做逐词还原：墨墨收录的是原形（rest on），文章里是变形（rests on）；
      // 变体表同时记住「哪个变体属于哪个窗口」，命中后弹层显示还原出的原形
      if (!useSession.getState().token) return
      const cands = phraseCandidates(parts, j)
      if (cands.length === 0) return

      const variantOf = new Map<string, (typeof cands)[number]>()
      for (const cand of cands) {
        for (const v of phraseVariants(cand.words)) {
          if (!variantOf.has(v)) variantOf.set(v, cand)
        }
      }

      const known = await lookupKnownPhrases([...variantOf.keys()])
      if (phraseForRef.current !== word) return
      // 候选本来就是最长优先；命中时把弹层文本换成命中的那个原形变体
      const hit = cands
        .map((cand) => {
          const matched = phraseVariants(cand.words).find((v) => known.has(v))
          return matched ? { ...cand, text: matched } : null
        })
        .find(Boolean)
      if (hit) setSheetPhrase(hit)
    })()
  }

  const fontSize = usePrefs((s) => s.readingFont)
  const [sizePanel, setSizePanel] = useState(false)
  /** 二级视图：文章库 / 生成页。同时只能开一个，返回动画与返回键由 hook 接管 */
  const sub = useSubView<'lib' | 'gen'>()
  /** 有学习记录的日期（倒序），给生成页的日期选择用 */
  const [days, setDays] = useState<string[]>([])

  const headerRef = useRef<HTMLElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  /** 打开文章库之前的阅读位置，返回时原地恢复 */
  const articleScroll = useRef(0)
  /**
   * 最后一次「页面可见时」观察到的滚动位置。
   *
   * 不能等到落盘那一刻再读 `scroller.scrollTop`：effect 的 cleanup 跑在 React
   * 提交之后，那时 `.body` 里装的已经是**目标栏目**的内容、阅读页变成 `display:none`，
   * 浏览器早把 scrollTop 夹进了新容器的可滚范围（详见下面落盘处的注释）。
   */
  const lastTopRef = useRef(0)
  /** `lastTopRef` 记的是哪篇文章的位置 —— 换文章必须清零，否则会把上一篇的位置套到新文章上 */
  const lastTopIdRef = useRef('')
  const headerStuck = useScrollStuck(headerRef)

  const today = dateKey()

  /** 只在真正读文章时计时：停在阅读栏目 + 打开着文章 + 不在子视图（文章库/生成） */
  const counting = active && Boolean(article) && !sub.isOpen
  const todaySeconds = useReadingClock(today, counting)

  const refreshLibrary = useCallback(async () => {
    setLibrary(await listArticles())
  }, [])

  useEffect(() => {
    void (async () => {
      const latest = await getLatestArticleOfDay(today)
      if (latest) setArticle(latest)
      await refreshLibrary()
      setDays(await listDays())
    })()
  }, [today, refreshLibrary])

  const targetSet = useMemo(
    () => new Set(article?.targetWords.map((w) => w.toLowerCase()) ?? []),
    [article],
  )

  /** 按固定句数切段落：段内连排，段间留白 */
  const paragraphs = useMemo(() => {
    const list = article?.sentences ?? []
    const out: ArticleSentence[][] = []
    for (let i = 0; i < list.length; i += SENTENCES_PER_PARA) {
      out.push(list.slice(i, i + SENTENCES_PER_PARA))
    }
    return out
  }, [article])

  const isTargetWord = useCallback(
    (word: string) => lemmaCandidates(word).some((c) => targetSet.has(c)),
    [targetSet],
  )

  function changeFontSize(next: FontSize) {
    usePrefs.getState().set('readingFont', next)
  }

  function changeWordLimit(next: number) {
    usePrefs.getState().set('readingLimit', next)
  }

  /** 复制全文：打开译文时按「一句原文、一句译文」逐句交替 */
  async function copyAll() {
    if (!article) return
    const text = articleToText(article, { withZh: showZh, perPara: SENTENCES_PER_PARA })
    const ok = await copyText(text)
    useToast.getState().show(ok ? '已复制全文' : '复制失败，可长按文章手动选择')
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
    setGenStage(null)

    try {
      const draft = await generateArticle(
        {
          words: req.words,
          kinds: req.kinds,
          level: req.level,
          date: req.date,
        },
        setGenStage,
      )
      setGenStage({ stage: 'save', attempt: 1 })
      const saved = await saveArticle(draft)
      // 生成成功了，选词草稿就没用了
      clearGenDraft()

      setArticle(saved)
      setShowZh(false)
      setMissing(missingWords(saved))
      await refreshLibrary()

      sub.close()

      // 用户已经切到别的栏目了，得让他知道文章好了
      if (!activeRef.current) useToast.getState().show('文章生成好了')
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败，请重试')
    } finally {
      setBusy(false)
      setGenStage(null)
    }
  }

  async function handleOpen(id: string) {
    const a = await getArticleById(id)
    if (!a) return
    setArticle(a)
    setShowZh(false)
    setMissing([])
    sub.close()
  }

  // 词卡是弹层不是二级视图（没有返回动画），返回键单独注册
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
    sub.open('lib')
  }

  async function openGenerate() {
    rememberScroll()
    // 日期可能变了（比如过了零点又学了新词），每次进来重读一次
    setDays(await listDays())
    setError(null)
    sub.open('gen')
  }

  async function handleDeleteArticle(id: string) {
    const wasOpen = article?.id === id
    await deleteArticle(id)
    clearReadPos(id)
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

    if (sub.isOpen) {
      scroller.scrollTop = 0
      return
    }
    const raf = requestAnimationFrame(() => {
      scroller.scrollTop = articleScroll.current
    })
    return () => cancelAnimationFrame(raf)
  }, [sub.isOpen])

  /**
   * 阅读位置落盘。
   *
   * 上面那个 effect 只管「文章库往返」，位置活在内存里；进程被系统回收就没了。
   * 这里按文章 id 存一份，冷启动回来接着读。
   */
  const articleId = article?.id ?? ''
  useEffect(() => {
    // 子视图打开时滚动容器显示的是列表，不该记成阅读位置
    if (!active || !articleId || sub.isOpen) return

    const scroller = findScrollParent(pageRef.current)
    if (!scroller) return

    // 换了文章：上一篇的位置不能拿来套在这一篇上
    if (lastTopIdRef.current !== articleId) {
      lastTopIdRef.current = articleId
      lastTopRef.current = 0
    }

    // 正文是异步读出来的，首帧高度往往不够，交给 restoreScroll 重试到位。
    // 优先用「刚才看着的位置」（同一会话内切栏目回来），没有才读落盘值（冷启动）。
    const saved = lastTopRef.current > 0 ? lastTopRef.current : readReadPos(articleId)
    let cancelRestore = () => {}
    if (saved > 0) {
      lastTopRef.current = saved
      articleScroll.current = saved
      cancelRestore = restoreScroll(scroller, saved)
    }

    let debounce = 0
    const onScroll = () => {
      // 切栏目时阅读页先变成 display:none，浏览器会把 scrollTop 夹到新容器的高度上，
      // 那个值不是用户的阅读位置。不可见期间一律不记（activeRef 在提交前就已更新）。
      if (!activeRef.current) return
      lastTopRef.current = scroller.scrollTop
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => saveReadPos(articleId, lastTopRef.current), 300)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.clearTimeout(debounce)
      cancelRestore()
      /*
       * 落盘用的是「最后观察到的位置」，不是此刻的 scroller.scrollTop。
       *
       * cleanup 跑在 React 提交之后：这时 `.body` 里已经换成目标栏目的内容，阅读页
       * 被 display:none，scrollTop 已被浏览器夹进新容器的可滚范围。统计页恰好高到
       * 能夹出一个非零的中间值（实测 2400 → 517），于是它被当成阅读位置存了下来；
       * 返回阅读时 restoreScroll 又按这个值把页面拽回去 —— 这就是「切到统计再回来
       * 位置就乱了」的成因。今日 / 设置 / 历史首页比阅读页矮得多，夹出来是 0，
       * 而 restoreScroll 对 0 直接跳过，所以那几栏看起来一切正常。
       */
      saveReadPos(articleId, lastTopRef.current)
    }
  }, [active, articleId, sub.isOpen])

  const hasArticle = Boolean(article)

  if (sub.view === 'gen') {
    return (
      <div className={styles.page} data-size={fontSize} data-view="gen" ref={pageRef}>
        <GenerateArticle
          days={days}
          today={today}
          initialLevel={level}
          initialLimit={wordLimit}
          busy={busy}
          stage={genStage}
          error={error}
          onBack={sub.close}
          onGenerate={handleGenerate}
          onLevelChange={(next) => usePrefs.getState().set('readingLevel', next)}
          onLimitChange={changeWordLimit}
        />
      </div>
    )
  }

  if (sub.view === 'lib') {
    return (
      <div className={styles.page} data-size={fontSize} data-view="lib" ref={pageRef}>
        <ArticleLibrary
          items={library}
          currentId={article?.id}
          onBack={sub.close}
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
      data-return={sub.returning ? 'true' : 'false'}
      ref={pageRef}
    >
      <header
        className={styles.header}
        ref={headerRef}
        data-stuck={headerStuck ? 'true' : 'false'}
      >
        <h1 className={styles.title}>阅读</h1>

        <div className={styles.actions}>
          {/* 今日阅读时长：不走按钮逻辑，始终显示；计时中用主色提示「在计」 */}
          <span
            className={styles.action}
            data-timer="true"
            data-on={counting}
            aria-label="今日阅读时长"
          >
            {fmtDuration(todaySeconds)}
          </span>
          {hasArticle && (
            <>
              <button
                type="button"
                className={styles.action}
                data-on={showZh}
                onClick={() => setShowZh(!showZh)}
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
            <div className={styles.titleRow}>
              <h2 className={styles.articleTitle}>{article.title}</h2>
              <button
                type="button"
                className={styles.copyBtn}
                onClick={() => void copyAll()}
                aria-label="复制全文"
                title={showZh ? '复制全文（含译文，逐句交替）' : '复制全文'}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="5.5" y="5.5" width="8" height="9" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M10.5 5.5V3.7c0-.66-.54-1.2-1.2-1.2H3.7c-.66 0-1.2.54-1.2 1.2v7.1c0 .66.54 1.2 1.2 1.2h1.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {showZh && article.titleZh && (
              <p className={styles.titleZh}>{article.titleZh}</p>
            )}

            <div className={styles.meta}>
              {monthDay(article.date)} · {wordCount(article)} 词 · {LEVEL_LABEL[article.level]}
              {article.genre ? ` · ${GENRE_LABEL[article.genre]}` : ''}
              {/* 生成后审计没过：不挡阅读，只如实说一句（具体原因在 title 里） */}
              {article.shortfall && (
                <span className={styles.shortfall} title={article.shortfall}>
                  {' '}
                  · 未完全达标
                </span>
              )}
              {/*
                缓存命中率：只在真的命中了才显示，老文章与不报用量的网关都不占位。
                它不看结果、只看请求结构 —— 换成另一批词表生成，这个数字应该基本不掉；
                掉了就说明提示词里又有什么动态内容插到了静态要求前面。
              */}
              {article.usage && article.usage.cached > 0 && (
                <span
                  title={
                    `输入 ${article.usage.prompt} / 输出 ${article.usage.completion} token，` +
                    `其中 ${article.usage.cached} 命中提示词缓存；` +
                    `${article.usage.calls} 次调用、${article.usage.requests} 次请求` +
                    (article.usage.requests > article.usage.calls ? '（有重试，钱重付过一次）' : '')
                  }
                >
                  {' '}
                  · 缓存 {Math.round((100 * article.usage.cached) / article.usage.prompt)}%
                </span>
              )}
            </div>

            <div className={styles.body}>
              {paragraphs.map((para, pi) => (
                <p key={pi} className={`${styles.para} ${styles.en}`}>
                  {para.map((s, si) => {
                    const parts = tokenize(s.en)
                    return (
                    <span key={si} data-sentence="true">
                      {parts.map((part, j) =>
                        part.isWord ? (
                          <span key={j} className={styles.glue}>
                            <button
                              type="button"
                              className={styles.word}
                              data-target={isTargetWord(part.text)}
                              onClick={() => openWord(parts, j)}
                            >
                              {part.text}
                            </button>
                            {part.tail}
                          </span>
                        ) : (
                          <span key={j}>{part.text}</span>
                        ),
                      )}
                      {showZh && s.zh && <span className={styles.zh}>{s.zh}</span>}
                      {/* 句子之间靠空白连排：不加这个空格，两句会粘在一起 */}
                      {' '}
                    </span>
                    )
                  })}
                </p>
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

      {sheetWord && (
        <WordSheet
          word={sheetWord}
          phrase={sheetPhrase}
          onClose={() => {
            phraseForRef.current = ''
            setSheetPhrase(null)
            setSheetWord(null)
          }}
          onPick={(next) => {
            phraseForRef.current = next
            setSheetPhrase(null)
            setSheetWord(next)
          }}
        />
      )}
    </div>
  )
}
