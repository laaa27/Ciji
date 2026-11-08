import type { StudyRecord } from '@/api/types'
import { addWords, queryStudyRecords } from '@/api/study'
import { queryVocabulary } from '@/api/vocabulary'
import { lemmaCandidates } from '@/data/dict'

/**
 * 一个词在墨墨里的状态。
 *
 * 只有四种结论，界面据此决定显示什么：
 * - in-plan  已经在学习计划里 → 展示学习情况
 * - available 词库里有、但没加入 → 可以加
 * - unknown  词库里没有这个词 → 加不了（短语、专名常见）
 * - error    接口没通 → 只显示释义，不打扰
 */
export type MemoState =
  | { kind: 'in-plan'; record: StudyRecord }
  | { kind: 'available'; vocId: string; spelling: string }
  | { kind: 'unknown' }
  | { kind: 'error'; message: string }

/** 同一个词在一次会话里只查一次：文章里反复点同一个词不必重复请求 */
const cache = new Map<string, MemoState>()

const keyOf = (word: string) => word.trim().toLowerCase()

/** 把词形候选里真正查到的那条取出来 */
function pickRecord(records: StudyRecord[], candidates: string[]): StudyRecord | null {
  const set = new Set(candidates.map((c) => c.toLowerCase()))
  return records.find((r) => set.has(r.voc_spelling.toLowerCase())) ?? null
}

/** 接口单次上限 1000，切小一点更稳 */
const CHUNK = 400

function chunk<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * 打开文章时批量预取。
 *
 * 一篇文章几十个词，两条请求就能把点词的等待省掉。
 *
 * 关键：**每个词都要展开成原形候选再查**。之前只查字面量，`shipments` 在墨墨里
 * 查不到就被缓存成「词库里没有」，点开时直接命中缓存 —— 连 shipment 都不去试。
 * 失败不写缓存，否则会把「网络不好」固化成「墨墨里没有」。
 */
export async function prefetchMemo(words: string[]): Promise<void> {
  const todo = [...new Set(words.map(keyOf))].filter((w) => w && !cache.has(w))
  if (todo.length === 0) return

  const candidatesOf = new Map<string, string[]>()
  const probeSet = new Set<string>()
  for (const w of todo) {
    const cands = lemmaCandidates(w).slice(0, 6)
    candidatesOf.set(w, cands)
    for (const c of cands) probeSet.add(c)
  }
  const probe = [...probeSet]

  const recordOf = new Map<string, StudyRecord>()
  const vocOf = new Map<string, { id: string; spelling: string }>()

  try {
    for (const part of chunk(probe)) {
      const rec = await queryStudyRecords({ spellings: part, limit: 1000 })
      for (const r of rec.records ?? []) recordOf.set(keyOf(r.voc_spelling), r)
    }

    const pending: string[] = []
    for (const w of todo) {
      const hit = (candidatesOf.get(w) ?? [w]).map((c) => recordOf.get(c)).find(Boolean)
      if (hit) cache.set(w, { kind: 'in-plan', record: hit })
      else pending.push(w)
    }
    if (pending.length === 0) return

    for (const part of chunk([...probeSet])) {
      const voc = await queryVocabulary(part)
      for (const v of voc.voc ?? []) vocOf.set(keyOf(v.spelling), v)
    }

    for (const w of pending) {
      const hit = (candidatesOf.get(w) ?? [w]).map((c) => vocOf.get(c)).find(Boolean)
      cache.set(
        w,
        hit ? { kind: 'available', vocId: hit.id, spelling: hit.spelling } : { kind: 'unknown' },
      )
    }
  } catch {
    // 预取是锦上添花，失败留给点开时单查
  }
}

/** 查一个词的状态。缓存优先，其次按「原形 → 词形还原候选」的顺序试 */
export async function lookupMemoState(word: string): Promise<MemoState> {
  const k = keyOf(word)
  const cached = cache.get(k)
  if (cached) return cached

  const candidates = lemmaCandidates(word).slice(0, 6)

  try {
    const rec = await queryStudyRecords({ spellings: candidates, limit: 50 })
    const hit = pickRecord(rec.records ?? [], candidates)
    if (hit) {
      const state: MemoState = { kind: 'in-plan', record: hit }
      cache.set(k, state)
      return state
    }

    const voc = await queryVocabulary(candidates)
    const list = voc.voc ?? []
    const set = new Set(candidates.map((c) => c.toLowerCase()))
    const match = list.find((v) => set.has(v.spelling.toLowerCase())) ?? list[0]

    const state: MemoState = match
      ? { kind: 'available', vocId: match.id, spelling: match.spelling }
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
    cache.set(keyOf(word), { kind: 'in-plan', record })
    cache.set(keyOf(state.spelling), { kind: 'in-plan', record })

    return { ok: true, message: '已加入学习计划，会按墨墨的排期复习' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '加入失败' }
  }
}
