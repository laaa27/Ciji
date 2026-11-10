/**
 * 异步小工具。
 *
 * 原先 `sleep` 在 api/client、api/llm、domain/article 各定义一次，三行代码抄三遍。
 * 收在这里，重试间隔的写法只有一处。
 */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
