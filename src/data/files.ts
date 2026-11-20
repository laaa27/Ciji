import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'

/**
 * App 私有目录下的 JSON 文件读写（0.24.26）。
 *
 * 为什么要有这一层：文章、每日记录、释义缓存三处都要「一个大对象一个文件」，
 * 原先只有 `article.ts` 会写文件，前两处若各自再抄一遍桥调用，就是第 3、第 4 份副本。
 *
 * Filesystem 的 web 实现走 IndexedDB，与原生 Directory.Data 语义一致，
 * 不需要平台分支。
 */

const DIR = Directory.Data

/** 读 JSON；文件不存在、内容坏掉、桥调用失败一律当「没有」——调用方按缺省处理即可 */
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    const { data } = await Filesystem.readFile({ path, directory: DIR, encoding: Encoding.UTF8 })
    return JSON.parse(data as string) as T
  } catch {
    return null
  }
}

/** 写 JSON；父目录不存在时先建（第一次写 days/ 就走这里） */
export async function writeJson(path: string, value: unknown): Promise<void> {
  const dir = parentOf(path)
  if (dir) await ensureDir(dir)
  await Filesystem.writeFile({
    path,
    directory: DIR,
    data: JSON.stringify(value),
    encoding: Encoding.UTF8,
    // 目录已经由 ensureDir 建好；这里的递归是给原生的兜底
    recursive: true,
  })
}

/**
 * 每个目录只建一次，而且**并发调用共用同一个 Promise**。
 *
 * 为什么必须有：web 端的 `Filesystem.writeFile(recursive: true)` 在父目录不存在时
 * 会自己调 `mkdir`，而那个 `mkdir` 遇到已存在的目录是**直接抛错**的
 * （`Current directory does already exist.`）。迁移与当日采集会同时首次写 `days/`，
 * 后到的那个就抛错、那天的快照直接丢掉——实测踩过，表现为历史/生成页少一天数据。
 */
const dirReady = new Map<string, Promise<void>>()

function ensureDir(dir: string): Promise<void> {
  const hit = dirReady.get(dir)
  if (hit) return hit
  const task = (async () => {
    try {
      await Filesystem.mkdir({ path: dir, directory: DIR, recursive: true })
    } catch {
      // 已经存在 = 目标状态已达成（并发创建时后到的那一个必然走到这里）
    }
  })()
  dirReady.set(dir, task)
  return task
}

function parentOf(path: string): string | null {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i) : null
}

/** 删文件；不存在等于目标状态已达成 */
export async function removeFile(path: string): Promise<void> {
  try {
    await Filesystem.deleteFile({ path, directory: DIR })
  } catch {
    // 文件不存在
  }
}

/** 列目录下的文件名（不递归）；目录不存在返回空数组 */
export async function listFileNames(dir: string): Promise<string[]> {
  try {
    const { files } = await Filesystem.readdir({ path: dir, directory: DIR })
    return files.map((f) => f.name)
  } catch {
    return []
  }
}

/**
 * 按 key 串行执行，避免「读-改-写」互相踩。
 *
 * 为什么必须有：每日记录的阅读秒数是「读文件 → 加秒 → 写回」，
 * 而采集落盘是「读文件 → 换掉快照 → 写回」，两条链同时跑会互相覆盖
 * （后者把前者的秒数写回旧值，或者前者把刚采到的快照写回旧的）。
 * 队列只按 key 串行，不同日期之间仍然并行。
 */
const queues = new Map<string, Promise<unknown>>()

export function queueByKey<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  // 前一个失败也要继续跑后一个，否则一次写失败会把这条队列永久卡死
  const next = prev.then(task, task)
  // 队尾存一个「已吞掉异常」的副本：既保持串行，又不至于产生 unhandled rejection
  queues.set(
    key,
    next.catch(() => {}),
  )
  return next
}
