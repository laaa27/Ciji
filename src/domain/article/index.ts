/**
 * 文章领域的门面：对外只暴露这个名字，内部按职责分文件。
 *
 * 拆之前是一个 502 行的 `article.ts`，同时住着类型、选词规则、生成编排、文本导出，
 * 调用方为了拿一个类型就得把 `api/llm` / `store/llm` 一起拉进依赖图，
 * 选词规则也因此没法在 node 里单测。
 *
 * 现在：
 * - `model.ts`     纯类型与 `KIND_LABEL`（零运行时依赖）
 * - `selection.ts` 选词规则（不碰模型，可单测）
 * - `text.ts`      词数与纯文本导出
 * - `generate.ts`  唯一碰 LLM 的部分（已知层间偏离关在这一个文件里）
 *
 * 保留 `@/domain/article` 的既有 import 路径，调用方零改动。
 */

export * from './model'
export * from './selection'
export * from './text'
export * from './generate'
export * from './usage'

/** 难度 / 文体的标签与配额住在 prompts.ts（零依赖），这里转出去保持既有 import 路径 */
export {
  GENRE_LABEL,
  LEVEL_LABEL,
  MAX_TARGET_WORDS,
  WORD_LIMITS,
  pickGenre,
} from '@/domain/prompts'

/** 缺词判定住在 generate/audit.ts（审计与阅读页的缺失提示共用），这里转出去 */
export { missingWords } from '@/domain/generate/audit'
