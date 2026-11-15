import { Preferences } from '@capacitor/preferences'

/**
 * 训练做题进度的落盘。
 *
 * 一套卷一个键（`training_progress:<paper_key>`），里面按篇目 id 分条：
 * 144 套 × 每套五六篇，一篇一个键会把 Preferences 撑成上千个条目，
 * 而安卓端读一次是把整个文件反序列化。
 *
 * 存的东西只有四样：选了什么、是否已提交、停在第几题、滚到哪。
 * 和阅读页记住「读到哪」是同一个诉求 —— 退出再进不该从头再来。
 */

export type PassageProgress = {
  /** 题号 → 选项字母 */
  answers: Record<number, string>
  submitted: boolean
  /** 当前题索引 */
  current: number
  /** 提交时间（ISO）。用来在试卷标题上显示「提交 21:07」 */
  submittedAt?: string
  /** 正文滚动位置 */
  scroll?: number
}

export type PaperProgress = Record<string, PassageProgress>

const keyOf = (paperKey: string) => `training_progress:${paperKey}`

export async function loadPaperProgress(paperKey: string): Promise<PaperProgress> {
  const { value } = await Preferences.get({ key: keyOf(paperKey) })
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as PaperProgress
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // 坏数据当没有：这一条丢了不影响别的篇目
    return {}
  }
}

export async function savePassageProgress(
  paperKey: string,
  passageId: string,
  progress: PassageProgress,
): Promise<void> {
  const all = await loadPaperProgress(paperKey)
  all[passageId] = progress
  await Preferences.set({ key: keyOf(paperKey), value: JSON.stringify(all) })
}

/** 清空某套卷的做题进度（换一套卷做时不受影响） */
export async function clearPaperProgress(paperKey: string): Promise<void> {
  await Preferences.remove({ key: keyOf(paperKey) })
}
