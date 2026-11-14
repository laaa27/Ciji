import { chatCompletion } from '@/api/llm'
import type { LlmProfile } from '@/store/llm'
import { cachedGloss, readGlossAlt, rememberGloss, saveGlossAlt } from '@/data/gloss'
import { lookupLocal, lookupLocalSync, warmShards } from '@/data/dict'

/**
 * 查词编排：一条固定的四级链，批量与单条共用同一套顺序。
 *
 * 1. 本地 ECDICT 分片（`data/dict`）—— 快、离线、覆盖单词
 * 2. 词形还原（`lib/lemma`）—— went → go，studies → study
 * 3. 永久缓存（`data/gloss`）—— AI 与 MyMemory 查过的词只请求一次
 * 4. AI 释义（用户配的模型）→ MyMemory（免费、无 key）兜底
 *
 * 两个在线层各有额度上限，但**不再静默丢词**：轮不上的词通过 `skipped`
 * 交回调用方（导出几千词时才会发生）。
 *
 * 模型配置由组合根注入（`setGlossModelProvider`）——domain 层不直接读 store，
 * 与 `api/client.ts` 的 `setTokenProvider` 同一套做法。
 */

export interface GlossModelConfig {
  profile: LlmProfile
  /** 查词是否开思考模式 */
  think: boolean
}

let glossModelProvider: () => GlossModelConfig | null = () => null

/** 由 `main.tsx` 注入：domain 不反向依赖 store */
export function setGlossModelProvider(fn: () => GlossModelConfig | null): void {
  glossModelProvider = fn
}

/** 一次 AI 释义请求最多带多少个词 */
export const AI_GLOSS_BATCH_CAP = 20

/**
 * 一次批量补查最多交给 AI 多少个词（按 `AI_GLOSS_BATCH_CAP` 分批循环）。
 * 上限存在是为了别在一次刷新里把用户的模型额度刷光；超出的部分交给 MyMemory，
 * 再超出（`ONLINE_MAX_WORDS`）就**如实报给调用方**，不再静默丢掉。
 */
const AI_BATCH_MAX_WORDS = 60

/** 一次批量补查最多交给 MyMemory 多少个词（免费接口有条数配额，不无限打） */
const ONLINE_MAX_WORDS = 60
/** MyMemory 请求并发上限 */
const ONLINE_CONCURRENCY = 3
/**
 * MyMemory 单次请求的超时。
 *
 * 实测这个免费接口很不稳定：同一台机器上时而 0.6 秒、时而 13 秒（并发 3 时更久）。
 * 没有超时的话，一批词能把刷新拖住一两分钟，而且请求会一直挂着。
 */
const ONLINE_TIMEOUT_MS = 10000

/**
 * AI 释义的系统提示。要点：
 * - 词和短语混在一起问，短语要给整体含义（rest on 是「依据」，不是「休息 上」）
 * - 词性打头、多义项分号分隔，跟 ECDICT 本地条目的观感保持一致
 * - 严格 JSON 输出，解析失败就整批放弃走 MyMemory，不要半截结果
 */
const AI_GLOSS_SYSTEM = [
  '你是英汉词典。对用户给出的每个英文单词或短语，给出简洁准确的中文释义。',
  '要求：',
  '1. 词性打头（n. / v. / adj. / adv. / prep. / phr. 等）',
  '2. 给出 2~3 个最常用的义项，用「；」分隔，最常用的放最前',
  '3. 短语给整体含义，不要逐词直译',
  '4. 只输出 JSON 对象（键是单词、值是释义字符串），不要输出任何其他文字',
].join('\n')

/** 解析 AI 返回的 { "单词": "释义" }；剥代码围栏、取首尾大括号，宽松容错 */
function parseAiGlosses(reply: string, words: string[]): Map<string, string> {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return new Map()

  try {
    const data = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>
    const out = new Map<string, string>()
    for (const w of words) {
      const g = data[w]
      if (typeof g === 'string' && g.trim()) out.set(w, g.trim())
    }
    return out
  } catch {
    return new Map()
  }
}

/**
 * 用释义模型批量查词。失败静默返回空 Map——释义是锦上添花，
 * 挂了就落到 MyMemory，绝不能因为 AI 层报错让查词变红字。
 */
async function aiGlossBatch(words: string[]): Promise<Map<string, string>> {
  const model = glossModelProvider()
  if (!model || words.length === 0) return new Map()

  const list = words.slice(0, AI_GLOSS_BATCH_CAP)
  try {
    // 思考模式默认关（设置里可开）：释义是短事实问答，不思考 11 秒内返回且足够准确，
    // 开了（low 档）实测要 50~90 秒，点词场景等不起。推理模型默认思考档又慢又贵，
    // 所以「关」必须显式发 thinking.disabled，不能靠不传参数。
    const opts = model.think
      ? { reasoningEffort: 'low' as const }
      : { thinkingDisabled: true as const }
    const { text } = await chatCompletion(
      [
        { role: 'system', content: AI_GLOSS_SYSTEM },
        { role: 'user', content: JSON.stringify(list) },
      ],
      // 释义是短事实问答：低温防跑偏；服务端不认这些字段会自动协商去掉
      { temperature: 0.2, maxTokens: 2048, timeoutMs: 30000, ...opts },
      model.profile,
    )
    return parseAiGlosses(text, list)
  } catch {
    return new Map()
  }
}

/** 简单并发控制，避免一次性打爆免费接口 */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await fn(items[index])
    }
  })
  await Promise.all(workers)
}

/** MyMemory：免费、无需 key、带 CORS 头。
 *  缓存检查放在批量调度的入口处（lookupWords / lookupOneDetailed），
 *  这里只负责发请求，避免同一段逻辑在两处各写一遍。 */
async function lookupOnline(word: string): Promise<string | null> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ONLINE_TIMEOUT_MS)
  try {
    const url =
      'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(word) +
      '&langpair=en|zh-CN'
    const res = await fetch(url, { signal: abort.signal })
    if (!res.ok) return null

    const json = (await res.json()) as {
      responseData?: { translatedText?: string }
      quotaFinished?: boolean
    }

    const raw = json.responseData?.translatedText?.trim()
    if (!raw) return null
    // 配额用尽或异常时，接口会在 translatedText 里返回提示语
    if (/MYMEMORY WARNING|NO QUERY SPECIFIED|QUERY LENGTH LIMIT/i.test(raw)) return null

    rememberGloss(word, raw, false)
    return raw
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface LookupOptions {
  /**
   * 本地/缓存结果先回调一次。
   * 界面拿到就能立刻渲染，不必等在线请求 —— 否则几个短语会把整页释义拖住好几秒。
   */
  onLocal?: (found: Map<string, string>) => void
  /**
   * 是否允许联网兜底，默认允许。
   *
   * 这不是用户开关（设置里已经没有那一项了），是**调用方按任务形态**决定的：
   * 导出几千个词的场景关掉它——MyMemory 实测单次 0.6~13 秒，几千词能拖到几十分钟，
   * 而导出本身只是要一份带释义的清单，本地词库 + 缓存已经够用。
   */
  allowOnline?: boolean
}

export interface BatchLookupResult {
  /** 拼写（小写） → 释义 */
  glosses: Map<string, string>
  /**
   * 超出单次补查上限、**根本没去查**的词。
   *
   * 和「查了但没查到」必须分开：前者是本可以查到的，只是这次没轮上（导出几千词时会发生），
   * 后者是词典/接口里真没有。以前两者混在一起、而且超限的词直接从返回值里消失，
   * 调用方连"少查了"都无从知晓。
   */
  skipped: string[]
}

/**
 * 批量查词。四层顺序固定（没有开关）：本地词典 → 永久缓存 → AI 释义 → MyMemory。
 *
 * 两个额度是硬上限，但**不再静默**：
 * - AI 最多 `AI_BATCH_MAX_WORDS` 个，按 `AI_GLOSS_BATCH_CAP` 分批循环（以前只发一批就丢）
 * - MyMemory 最多 `ONLINE_MAX_WORDS` 个
 * - 两者都轮不上的词进 `skipped`，交调用方如实提示
 *
 * 缓存检查放在 AI 之前：以前批量路径不读缓存，每次刷新/导出都把同一批词重新发给模型，
 * 既花钱又白占额度。
 */
export async function lookupWords(
  spellings: string[],
  opts: LookupOptions = {},
): Promise<BatchLookupResult> {
  const glosses = new Map<string, string>()
  if (spellings.length === 0) return { glosses, skipped: [] }

  const unique = [...new Set(spellings.map((s) => s.trim().toLowerCase()))].filter(Boolean)

  // ① 本地词典：先并行预热分片，再同步查表（避免逐词 await 把 fetch 串起来）
  await warmShards(unique)
  const missing: string[] = []
  for (const word of unique) {
    const gloss = lookupLocalSync(word)
    if (gloss) glosses.set(word, gloss)
    else missing.push(word)
  }

  // 本地能查到的先交出去
  opts.onLocal?.(new Map(glosses))

  // ② 永久缓存：查过 AI / MyMemory 的词直接拿结果，不再发请求
  const toQuery: string[] = []
  for (const word of missing) {
    const cached = await cachedGloss(word)
    if (cached) glosses.set(word, cached.gloss)
    else toQuery.push(word)
  }

  if (toQuery.length === 0) return { glosses, skipped: [] }

  // ③ AI 释义：分批循环，而不是发一批就收工
  const aiWords = toQuery.slice(0, AI_BATCH_MAX_WORDS)
  for (let i = 0; i < aiWords.length; i += AI_GLOSS_BATCH_CAP) {
    const chunk = aiWords.slice(i, i + AI_GLOSS_BATCH_CAP)
    const ai = await aiGlossBatch(chunk)
    for (const [word, gloss] of ai) {
      glosses.set(word, gloss)
      // 词表里批量补出来的 AI 释义也要留来源：稍后点这个词时才能继续标「AI 释义」
      rememberGloss(word, gloss, true)
    }
  }

  const afterAi = toQuery.filter((word) => !glosses.has(word))
  if (opts.allowOnline === false) {
    // 调用方明确不要联网（导出）：剩下的词就是没释义，也不算"没轮上"
    return { glosses, skipped: [] }
  }

  // ④ MyMemory 兜底（并发 3，单请求有超时）
  const onlineWords = afterAi.slice(0, ONLINE_MAX_WORDS)
  await mapLimit(onlineWords, ONLINE_CONCURRENCY, async (word) => {
    const gloss = await lookupOnline(word)
    if (gloss) glosses.set(word, gloss)
  })

  const skipped = afterAi.slice(ONLINE_MAX_WORDS)
  return { glosses, skipped }
}

export interface GlossResult {
  gloss: string | null
  /** 这次释义是不是 AI 产生的（本地词典 / MyMemory 是 false；命中 AI 缓存记的是 true） */
  ai: boolean
}

/**
 * 问模型要一条释义（跳过本地词典与缓存，就是"再问一次"）。
 *
 * `asMain`：主释义本身就是 AI 给的（这个词本地没收录、当初由 AI 兜底生成），
 * 那时"重新生成"应当更新主释义，而不是再堆一条一模一样的备选。
 * 返回 null 表示没配模型或调用失败——界面据此提示，不要假装成功。
 */
export async function requestAiGloss(
  word: string,
  opts: { asMain?: boolean } = {},
): Promise<string | null> {
  const key = word.trim().toLowerCase()
  if (!key) return null

  const ai = await aiGlossBatch([key])
  const gloss = ai.get(key)
  if (!gloss) return null

  const alt = await readGlossAlt(key)

  if (opts.asMain) {
    rememberGloss(key, gloss, true)
    // 主释义已经是 AI 了，备选里那份 AI 释义就成了重复内容，一并清掉
    if (alt.ai) await saveGlossAlt(key, { ...alt, ai: undefined })
  } else {
    await saveGlossAlt(key, { ...alt, ai: gloss })
  }

  return gloss
}

/**
 * 单条查词（阅读页点词用），带来源标记和本地先行回调。
 *
 * 顺序与批量完全一致：本地词典 → 永久缓存 → AI 释义 → MyMemory。
 * （以前单条路径不看「联网补查」开关、批量路径看，同一个开关两种行为；
 * 现在开关已删除，两条路径共用同一条链，不会再漂移。）
 * onLocal 在本地/缓存命中时先回调一次，让弹层立刻有内容——
 * AI 释义要走一次网络调用，等它再渲染会把瞬时查询拖成秒级。
 * 回调连 `ai` 一起给，缓存里的 AI 释义才不会先按普通释义渲染一帧再补标签。
 */

/**
 * 单条查词（阅读页点词用），带来源标记和本地先行回调。
 *
 * 顺序与批量完全一致：本地词典 → 永久缓存 → AI 释义 → MyMemory。
 * （以前单条路径不看「联网补查」开关、批量路径看，同一个开关两种行为；
 * 现在开关已删除，两条路径共用同一条链，不会再漂移。）
 * onLocal 在本地/缓存命中时先回调一次，让弹层立刻有内容——
 * AI 释义要走一次网络调用，等它再渲染会把瞬时查询拖成秒级。
 * 回调连 `ai` 一起给，缓存里的 AI 释义才不会先按普通释义渲染一帧再补标签。
 */
export async function lookupOneDetailed(
  text: string,
  opts: { onLocal?: (gloss: string, ai: boolean) => void } = {},
): Promise<GlossResult> {
  const key = text.trim().toLowerCase()
  if (!key) return { gloss: null, ai: false }

  const local = await lookupLocal(key)
  if (local) {
    opts.onLocal?.(local, false)
    return { gloss: local, ai: false }
  }

  // 命中缓存时按落盘时记下的来源返回，首次查询与二次查询表现一致
  const cached = await cachedGloss(key)
  if (cached) {
    opts.onLocal?.(cached.gloss, cached.ai)
    return { gloss: cached.gloss, ai: cached.ai }
  }

  const ai = await aiGlossBatch([key])
  const aiGloss = ai.get(key)
  if (aiGloss) {
    rememberGloss(key, aiGloss, true)
    return { gloss: aiGloss, ai: true }
  }

  const online = await lookupOnline(key)
  if (online) return { gloss: online, ai: false }
  return { gloss: null, ai: false }
}

/** 单条查词，阅读功能点词时用（不需要来源标记的旧调用方） */
export async function lookupOne(text: string): Promise<string | null> {
  return (await lookupOneDetailed(text)).gloss
}
