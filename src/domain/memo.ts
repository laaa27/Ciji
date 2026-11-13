import type { StudyRecord } from '@/api/types'
import { addWords, advanceStudy, queryStudyRecords } from '@/api/study'
import { queryVocabulary } from '@/api/vocabulary'
import { lemmaCandidates } from '@/lib/lemma'

/**
 * 一个词在墨墨里的状态。
 *
 * 只有四种结论，界面据此决定显示什么：
 * - in-plan  已经在学习计划里 → 展示学习情况
 * - available 词库里有、但没加入 → 可以加
 * - unknown  词库里没有这个词 → 加不了（短语、专名常见）
 * - error    接口没通 → 只显示释义，不打扰
 *
 * `exact` 是关键的一位：命中的是**用户点的那个词本身**（true），还是**猜出来的原形**
 * （false）。界面必须分开写这两件事 —— 以前把 file 的计划状态直接写成
 * 「原形 file」，用户会以为 filing 本身在计划里。
 */
export type MemoState =
  | { kind: 'in-plan'; record: StudyRecord; exact: boolean }
  | { kind: 'available'; vocId: string; spelling: string; exact: boolean }
  | { kind: 'unknown' }
  | { kind: 'error'; message: string }

/** 同一个词在一次会话里只查一次：文章里反复点同一个词不必重复请求 */
const cache = new Map<string, MemoState>()

const keyOf = (word: string) => word.trim().toLowerCase()

/**
 * 按「候选可信度」挑第一条命中，而不是「服务端先返回谁就认谁」。
 *
 * 墨墨的 query 接口只是按拼写批量查，返回顺序不构成任何保证；
 * 以前用 Set 判断「在候选集合里」，于是 site / sit 谁先回来就用谁。
 */
export function pickByCandidateOrder<T>(
  items: T[],
  candidates: string[],
  spellingOf: (item: T) => string,
): T | null {
  for (const cand of candidates) {
    for (const item of items) {
      if (spellingOf(item).trim().toLowerCase() === cand) return item
    }
  }
  return null
}

/**
 * 查一个词的状态。
 *
 * 两段语义，顺序不能反：
 * 1. **原词优先**：`lemmaCandidates` 第一项就是用户点的词本身。命中就报它自己，
 *    不做任何"原形"推断；
 * 2. 原词不在词库里，才按候选顺序退到还原形式，并把这个事实（exact: false）
 *    交给界面去如实说明。
 */
export async function lookupMemoState(word: string): Promise<MemoState> {
  const k = keyOf(word)
  const cached = cache.get(k)
  if (cached) return cached

  const candidates = lemmaCandidates(word).slice(0, 6)
  const exact = candidates[0]

  try {
    const rec = await queryStudyRecords({ spellings: candidates, limit: 50 })
    const hit = pickByCandidateOrder(rec.records ?? [], candidates, (r) => r.voc_spelling)
    if (hit) {
      const state: MemoState = {
        kind: 'in-plan',
        record: hit,
        exact: keyOf(hit.voc_spelling) === exact,
      }
      cache.set(k, state)
      return state
    }

    const voc = await queryVocabulary(candidates)
    const match = pickByCandidateOrder(voc.voc ?? [], candidates, (v) => v.spelling)
    const state: MemoState = match
      ? {
          kind: 'available',
          vocId: match.id,
          spelling: match.spelling,
          exact: keyOf(match.spelling) === exact,
        }
      : { kind: 'unknown' }
    cache.set(k, state)
    return state
  } catch (e) {
    const message = e instanceof Error ? e.message : '读取失败'
    // 错误不写缓存，下次点开还能重试
    return { kind: 'error', message }
  }
}

export interface AddResult {
  ok: boolean
  message: string
}

/**
 * 加入学习计划。
 *
 * `advance: false` —— 只排进计划、按墨墨自己的节奏复习，不打断用户当前的复习队列。
 * 想"加完立刻背"的话把它改成 true。
 *
 * 先查状态再调用，是因为 added_count 无法区分「额度不足」和「已经在计划里」。
 */
export async function addToPlan(word: string): Promise<AddResult> {
  const state = await lookupMemoState(word)

  if (state.kind === 'in-plan') {
    return { ok: false, message: '这个词已经在你的学习计划里了' }
  }
  if (state.kind === 'unknown') {
    return { ok: false, message: '墨墨词库里没有这个词，加不进去' }
  }
  if (state.kind === 'error') {
    return { ok: false, message: state.message }
  }

  try {
    const res = await addWords([state.vocId], false)
    if ((res.added_count ?? 0) <= 0) {
      return {
        ok: false,
        message: '没能加入：可能今天的单词额度已满，或这个词已经在计划里',
      }
    }

    // 加完把记录读回来，让词卡立刻显示真实状态（读不到就先给个空壳）
    const rec = await queryStudyRecords({ spellings: [state.spelling], limit: 10 }).catch(
      () => null,
    )
    const record = rec?.records?.[0] ?? {
      voc_id: state.vocId,
      voc_spelling: state.spelling,
      study_count: 0,
    }
    cache.set(keyOf(word), {
      kind: 'in-plan',
      record,
      exact: keyOf(record.voc_spelling) === keyOf(word),
    })
    cache.set(keyOf(state.spelling), { kind: 'in-plan', record, exact: true })

    return { ok: true, message: '已加入学习计划，会按墨墨的排期复习' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '加入失败' }
  }
}

/**
 * 把已在计划里的词提前到今天复习。
 *
 * 与加入计划一样，先查状态再调用 —— 只有真正在计划里的词才有 id 可提前。
 */
export async function advanceWord(word: string): Promise<AddResult> {
  const state = await lookupMemoState(word)

  if (state.kind === 'error') return { ok: false, message: state.message }
  if (state.kind === 'unknown') return { ok: false, message: '墨墨词库里没有这个词' }
  if (state.kind === 'available') return { ok: false, message: '这个词还没加入学习计划' }

  try {
    const res = await advanceStudy([state.record.voc_id])
    if ((res.advanced_count ?? 0) <= 0) {
      return {
        ok: false,
        message: '没能提前：需要墨墨 10 级以上，或这个词今天已经排进复习了',
      }
    }

    // 提前之后复习日期会变，把记录读回来（读不到就保留原样）
    const rec = await queryStudyRecords({
      spellings: [state.record.voc_spelling],
      limit: 10,
    }).catch(() => null)
    if (rec?.records?.[0]) {
      const record = rec.records[0]
      cache.set(keyOf(word), {
        kind: 'in-plan',
        record,
        exact: keyOf(record.voc_spelling) === keyOf(word),
      })
    }

    return { ok: true, message: '已提前到今天，去墨墨背它吧' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '提前失败' }
  }
}

/* ── 短语匹配：以墨墨词库为准 ─────────────── */

/**
 * 墨墨词库里有没有这些短语。
 *
 * 为什么不用本地词典当唯一依据：`public/dict` 只是 ECDICT 的精简分片，
 * 抽查 20 个高频搭配只命中 7 个（in spite of / as a result / in the dark / at the expense of 都没有），
 * 而墨墨同一批 14/14 全收。所以本地当快路径，墨墨当权威。
 *
 * 一次调用只发一个请求（spellings 是数组），命中结果按短语缓存，重复点同一个位置不再请求。
 */
const phraseCache = new Map<string, boolean>()

export async function lookupKnownPhrases(texts: string[]): Promise<Set<string>> {
  const need = texts.filter((t) => !phraseCache.has(t))

  if (need.length > 0) {
    try {
      const res = await queryVocabulary(need)
      const got = new Set((res.voc ?? []).map((v) => v.spelling.toLowerCase()))
      for (const t of need) phraseCache.set(t, got.has(t))
      // 服务端可能把拼写规范化过（大小写/连字符），命中的按返回值再记一次
      for (const v of res.voc ?? []) phraseCache.set(v.spelling.toLowerCase(), true)
    } catch {
      // 失败不写缓存：下次点还能重试，不至于永久判"没有"
      return new Set()
    }
  }

  return new Set(texts.filter((t) => phraseCache.get(t)))
}
