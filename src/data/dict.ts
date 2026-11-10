import { Preferences } from '@capacitor/preferences'

import { chatCompletion } from '@/api/llm'
import { useLlm } from '@/store/llm'

/**
 * 查词：本地词典优先，查不到再走在线翻译。
 *
 * 三层：
 * 1. 本地 ECDICT 分片（按首字母懒加载）—— 快、离线、覆盖单词
 * 2. 词形还原 —— went → go，studies → study，解决变形词
 * 3. 在线兜底（MyMemory，免费无 key）—— 解决短语和生僻词
 *
 * 在线结果会写进 Preferences 永久缓存，同一个词只请求一次。
 * 墨墨自己的 Vocabulary 接口不含释义（只有 id + spelling），所以释义必须外部解决。
 */

const SHARD_CACHE = new Map<string, Record<string, string>>()
const SHARD_INFLIGHT = new Map<string, Promise<Record<string, string>>>()
const GLOSS_MEMORY = new Map<string, string>()

const GLOSS_PREFIX = 'gloss:'
const ONLINE_FLAG = 'online_lookup'

/** 一次查词最多在线补这么多个，避免耗尽免费配额 */
const MAX_ONLINE_PER_CALL = 20
/** 在线请求并发上限 */
const ONLINE_CONCURRENCY = 3

/**
 * 一次 AI 释义最多问多少个词。
 * 批量场景（今日页/历史页词表）缺的词合并成一个请求，
 * 不是逐词发——一次调用的等待时间和 20 次是一样的。
 */
export const AI_GLOSS_BATCH_CAP = 20

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
  const profile = useLlm.getState().glossActive()
  if (!profile || words.length === 0) return new Map()

  const list = words.slice(0, AI_GLOSS_BATCH_CAP)
  try {
    // 思考模式默认关（设置里可开）：释义是短事实问答，不思考 11 秒内返回且足够准确，
    // 开了（low 档）实测要 50~90 秒，点词场景等不起。推理模型默认思考档又慢又贵，
    // 所以「关」必须显式发 thinking.disabled，不能靠不传参数。
    const opts = useLlm.getState().thinkGloss
      ? { reasoningEffort: 'low' as const }
      : { thinkingDisabled: true as const }
    const reply = await chatCompletion(
      [
        { role: 'system', content: AI_GLOSS_SYSTEM },
        { role: 'user', content: JSON.stringify(list) },
      ],
      // 释义是短事实问答：低温防跑偏；服务端不认这些字段会自动协商去掉
      { temperature: 0.2, maxTokens: 2048, timeoutMs: 30000, ...opts },
      profile,
    )
    return parseAiGlosses(reply, list)
  } catch {
    return new Map()
  }
}

/** 释义缓存读取（AI 与在线兜底共用同一个缓存，都是永久保存） */
async function cachedGloss(word: string): Promise<string | null> {
  const mem = GLOSS_MEMORY.get(word)
  if (mem) return mem

  const { value } = await Preferences.get({ key: GLOSS_PREFIX + word })
  if (value) {
    GLOSS_MEMORY.set(word, value)
    return value
  }
  return null
}

/** AI 释义写入永久缓存：同一个词这辈子只问一次模型 */
function rememberGloss(word: string, gloss: string): void {
  GLOSS_MEMORY.set(word, gloss)
  void Preferences.set({ key: GLOSS_PREFIX + word, value: gloss })
}

let onlineEnabled = true

export function setOnlineLookup(enabled: boolean) {
  onlineEnabled = enabled
}

export function isOnlineLookupEnabled() {
  return onlineEnabled
}

/** 启动时读取设置 */
export async function loadLookupSettings(): Promise<void> {
  const { value } = await Preferences.get({ key: ONLINE_FLAG })
  onlineEnabled = value !== 'false'
}

export async function saveOnlineLookup(enabled: boolean): Promise<void> {
  onlineEnabled = enabled
  await Preferences.set({ key: ONLINE_FLAG, value: enabled ? 'true' : 'false' })
}

function shardKey(word: string): string {
  const first = word.trim().charAt(0).toLowerCase()
  return first >= 'a' && first <= 'z' ? first : 'other'
}

async function loadShard(key: string): Promise<Record<string, string>> {
  const hit = SHARD_CACHE.get(key)
  if (hit) return hit

  const pending = SHARD_INFLIGHT.get(key)
  if (pending) return pending

  const task = (async () => {
    try {
      const res = await fetch(`dict/${key}.json`)
      if (!res.ok) return {}
      const data = (await res.json()) as Record<string, string>
      SHARD_CACHE.set(key, data)
      return data
    } catch {
      return {}
    } finally {
      SHARD_INFLIGHT.delete(key)
    }
  })()

  SHARD_INFLIGHT.set(key, task)
  return task
}

/** 不规则复数/不规则动词变形：只收考试词库里高频的那几个，宁缺毋滥 */
const IRREGULAR: Record<string, string> = {
  men: 'man', women: 'woman', children: 'child', feet: 'foot', teeth: 'tooth',
  mice: 'mouse', geese: 'goose', people: 'person', oxen: 'ox', brethren: 'brother',
  analyses: 'analysis', diagnoses: 'diagnosis', theses: 'thesis', crises: 'crisis',
  hypotheses: 'hypothesis', parentheses: 'parenthesis',
  criteria: 'criterion', phenomena: 'phenomenon',
  indices: 'index', matrices: 'matrix', vertices: 'vertex', appendices: 'appendix',
  // ── 不规则动词（短语还原依赖它们：was meant to → be meant to）──
  was: 'be', were: 'be', been: 'be', being: 'be', am: 'be', is: 'be', are: 'be',
  has: 'have', had: 'have', does: 'do', did: 'do', done: 'do',
  meant: 'mean', went: 'go', gone: 'go', made: 'make', said: 'say',
  took: 'take', taken: 'take', came: 'come', got: 'get', gave: 'give', given: 'give',
  told: 'tell', thought: 'think', left: 'leave', felt: 'feel', kept: 'keep',
  held: 'hold', brought: 'bring', knew: 'know', known: 'know', stood: 'stand',
  understood: 'understand', spent: 'spend', built: 'build', sent: 'send',
  met: 'meet', heard: 'hear', led: 'lead', won: 'win', sold: 'sell', lost: 'lose',
  caught: 'catch', chose: 'choose', chosen: 'choose', found: 'find',
  seen: 'see', saw: 'see', spoken: 'speak', spoke: 'speak', written: 'write',
  drove: 'drive', driven: 'drive', broken: 'break', broke: 'break',
  forgotten: 'forget', forgot: 'forget', hidden: 'hide', hid: 'hide',
  eaten: 'eat', ate: 'eat', fallen: 'fall', fell: 'fall', drawn: 'draw', drew: 'draw',
  grown: 'grow', grew: 'grow', flown: 'fly', flew: 'fly', worn: 'wear', wore: 'wear',
  torn: 'tear', tore: 'tear', begun: 'begin', began: 'begin', become: 'become',
  became: 'become', ran: 'run', rose: 'rise', arisen: 'arise', arose: 'arise',
  drunk: 'drink', drank: 'drink', sung: 'sing', sang: 'sing', swum: 'swim', swam: 'swim',
  woken: 'wake', woke: 'wake', frozen: 'freeze', froze: 'freeze', stolen: 'steal', stole: 'steal',
  hung: 'hang', dug: 'dig', stuck: 'stick', struck: 'strike', shaken: 'shake', shook: 'shake',
  lent: 'lend', bent: 'bend', crept: 'creep', dealt: 'deal',
  sat: 'sit', bit: 'bite', wound: 'wind', ridden: 'ride', rode: 'ride',
}

/**
 * 词形还原候选：按常见后缀反推原形。
 * 不追求语言学正确，能覆盖考试词库里的规则变化即可。
 *
 * 顺序很重要：越可信的越靠前，调用方通常取第一个查得到的。
 */
export function lemmaCandidates(word: string): string[] {
  const w = word.toLowerCase()
  const out: string[] = [w]
  const add = (s: string) => {
    if (s.length >= 2 && !out.includes(s)) out.push(s)
  }

  // 规则变化
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y')
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y')
  if (w.endsWith('es')) add(w.slice(0, -2))
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1))
  // wives → wife / leaves → leaf / knives → knife
  if (w.endsWith('ves')) {
    add(w.slice(0, -3) + 'f')
    add(w.slice(0, -3) + 'fe')
  }
  // analyses → analysis（-es 只会得到 analyse，再补一条 -is）
  if (w.endsWith('ses')) add(w.slice(0, -2) + 'is')

  // 不规则复数
  const irregular = IRREGULAR[w]
  if (irregular) add(irregular)
  if (w.endsWith('ed')) {
    const stem = w.slice(0, -2)
    add(stem)
    add(w.slice(0, -1))
    // stopped → stopp → stop（去掉双写）
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1))
    }
    // studied → studi → study
    if (stem.endsWith('i')) add(stem.slice(0, -1) + 'y')
  }
  if (w.endsWith('ing')) {
    add(w.slice(0, -3))
    add(w.slice(0, -3) + 'e')
    // running → run（去掉双写）
    const stem = w.slice(0, -3)
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      add(stem.slice(0, -1))
    }
  }
  if (w.endsWith('est')) {
    const stem = w.slice(0, -3)
    add(stem)
    add(w.slice(0, -2))
    // happiest → happi → happy
    if (stem.endsWith('i')) add(stem.slice(0, -1) + 'y')
  }
  if (w.endsWith('er')) {
    const stem = w.slice(0, -2)
    add(stem)
    add(w.slice(0, -1))
    // happier → happi → happy
    if (stem.endsWith('i')) add(stem.slice(0, -1) + 'y')
  }

  return out
}

/**
 * 查不规则变形的原形（was→be、meant→mean 这类后缀规则推不出来的）。
 * 短语还原用：功能词（was/had/did…）没有后缀变形，但它们的不规则原形
 * 恰恰是词库短语的写法（be meant to / have to / do away with）。
 */
export function irregularLemma(word: string): string | null {
  return IRREGULAR[word] ?? null
}

/**
 * 本地词典里有没有这个词（查变形候选时用来去噪）。
 * 纯本地分片查询，不走网络。
 */
export async function dictHas(word: string): Promise<boolean> {
  const key = word.trim().toLowerCase()
  if (!key) return false
  const shard = await loadShard(shardKey(key))
  return Boolean(shard[key])
}

async function lookupLocal(word: string): Promise<string | null> {
  for (const cand of lemmaCandidates(word)) {
    const shard = await loadShard(shardKey(cand))
    const hit = shard[cand]
    if (hit) return hit
  }
  return null
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

/** MyMemory：免费、无需 key、带 CORS 头 */
async function lookupOnline(word: string): Promise<string | null> {
  const mem = GLOSS_MEMORY.get(word)
  if (mem) return mem

  const { value } = await Preferences.get({ key: GLOSS_PREFIX + word })
  if (value) {
    GLOSS_MEMORY.set(word, value)
    return value
  }

  try {
    const url =
      'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(word) +
      '&langpair=en|zh-CN'
    const res = await fetch(url)
    if (!res.ok) return null

    const json = (await res.json()) as {
      responseData?: { translatedText?: string }
      quotaFinished?: boolean
    }

    const raw = json.responseData?.translatedText?.trim()
    if (!raw) return null
    // 配额用尽或异常时，接口会在 translatedText 里返回提示语
    if (/MYMEMORY WARNING|NO QUERY SPECIFIED|QUERY LENGTH LIMIT/i.test(raw)) return null

    GLOSS_MEMORY.set(word, raw)
    void Preferences.set({ key: GLOSS_PREFIX + word, value: raw })
    return raw
  } catch {
    return null
  }
}

export interface LookupOptions {
  /** 是否允许联网兜底，默认跟随设置 */
  online?: boolean
  /**
   * 本地结果先回调一次。
   * 界面拿到就能立刻渲染，不必等在线请求 —— 否则几个短语会把整页释义拖住好几秒。
   */
  onLocal?: (found: Map<string, string>) => void
}

/**
 * 批量查词，返回 拼写（小写） → 释义。
 * 查不到的不会出现在结果里，界面据此显示占位而不是空白。
 *
 * 三层顺序：本地词典 → AI 释义（缺词合并一次调用，结果永久缓存）→ MyMemory。
 * AI 挂了静默落到 MyMemory，不会让批量查询变红字。
 */
export async function lookupWords(
  spellings: string[],
  opts: LookupOptions = {},
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (spellings.length === 0) return result

  const unique = [...new Set(spellings.map((s) => s.trim().toLowerCase()))].filter(Boolean)
  const missing: string[] = []

  for (const word of unique) {
    const gloss = await lookupLocal(word)
    if (gloss) result.set(word, gloss)
    else missing.push(word)
  }

  // 本地能查到的先交出去
  opts.onLocal?.(new Map(result))

  const allowOnline = opts.online ?? onlineEnabled
  if (allowOnline && missing.length > 0) {
    // AI 层：本地没有的词交给释义模型（没配模型/调用失败都是空 Map，无缝落到下一层）
    const ai = await aiGlossBatch(missing)
    for (const [word, gloss] of ai) {
      result.set(word, gloss)
      rememberGloss(word, gloss)
    }

    const stillMissing = missing.filter((word) => !result.has(word))
    const batch = stillMissing.slice(0, MAX_ONLINE_PER_CALL)
    await mapLimit(batch, ONLINE_CONCURRENCY, async (word) => {
      const gloss = await lookupOnline(word)
      if (gloss) result.set(word, gloss)
    })
  }

  return result
}

export interface GlossResult {
  gloss: string | null
  /** 这次释义是不是 AI 产生的（本地词典 / 缓存 / 在线兜底都是 false） */
  ai: boolean
}

/**
 * 单条查词（阅读页点词用），带来源标记和本地先行回调。
 *
 * 顺序：本地词典 → 永久缓存 → AI 释义 → MyMemory。
 * onLocal 在本地/缓存命中时先回调一次，让弹层立刻有内容——
 * AI 释义要走一次网络调用，等它再渲染会把瞬时查询拖成秒级。
 */
export async function lookupOneDetailed(
  text: string,
  opts: { onLocal?: (gloss: string) => void } = {},
): Promise<GlossResult> {
  const key = text.trim().toLowerCase()
  if (!key) return { gloss: null, ai: false }

  const local = await lookupLocal(key)
  if (local) {
    opts.onLocal?.(local)
    return { gloss: local, ai: false }
  }

  const cached = await cachedGloss(key)
  if (cached) {
    opts.onLocal?.(cached)
    return { gloss: cached, ai: false }
  }

  const ai = await aiGlossBatch([key])
  const aiGloss = ai.get(key)
  if (aiGloss) {
    rememberGloss(key, aiGloss)
    return { gloss: aiGloss, ai: true }
  }

  if (onlineEnabled) {
    const online = await lookupOnline(key)
    if (online) return { gloss: online, ai: false }
  }
  return { gloss: null, ai: false }
}

/** 单条查词，阅读功能点词时用（不需要来源标记的旧调用方） */
export async function lookupOne(text: string): Promise<string | null> {
  return (await lookupOneDetailed(text)).gloss
}
