/**
 * 迁移里「写出去 → 读回来 → 对得上才敢删旧键」的校验步骤。
 *
 * 为什么单独抽：迁移是本 App 唯一会删除用户数据所在键的操作，三处实现
 * （每日记录 / 释义缓存 / 文章正文与索引）原先各写一遍，而且校验条件并不相同
 * （有的逐词全等、有的只比条数）。改一处漏两处，代价是丢数据。
 *
 * 这里保持零依赖：读写由调用方注入。生产走 `data/files`，单测喂一个会「写坏」的
 * 假实现，才能把「校验不过就抛错、绝不往下删键」这条规则钉住。
 */

export type DumpIo<T> = {
  write: (path: string, payload: T) => Promise<void>
  read: (path: string) => Promise<T | null>
}

/**
 * 写一份文件并读回校验；`same` 返回 false 就抛错。
 * 抛错是**期望行为**：调用方据此中断迁移，让旧键留在原处（慢一点，但不会丢）。
 */
export async function writeDumpVerified<T>(
  io: DumpIo<T>,
  path: string,
  payload: T,
  same: (back: T | null) => boolean,
  message: string,
): Promise<void> {
  await io.write(path, payload)
  await assertSaved(io, path, same, message)
}

/** 只做「读回比对」。写入已经发生、需要按别的条件再确认时用（文章按 id 校验） */
export async function assertSaved<T>(
  io: Pick<DumpIo<T>, 'read'>,
  path: string,
  same: (back: T | null) => boolean,
  message: string,
): Promise<void> {
  const back = await io.read(path)
  if (!same(back)) throw new Error(message)
}

/**
 * 逐词全等的副本比对：键集合一致，且每个值一字不差。
 * 释义与每日记录用它——这些值无法再生，差一个字都算失败。
 */
export function sameRecord(
  back: Record<string, string> | undefined,
  expect: Record<string, string>,
): boolean {
  if (!back) return false
  const keys = Object.keys(expect)
  if (Object.keys(back).length !== keys.length) return false
  return keys.every((k) => back[k] === expect[k])
}
