/**
 * 文章生成提示词。
 *
 * 为什么单独抽成一个零依赖模块：
 * 1. `scripts/gen-article.mjs` 要在 node 里用**同一份文本**生成文章做对比实验，
 *    如果提示词写在 article.ts 里，脚本就得把 store / dict / 墨墨接口一起拉进来，跑不起来；
 * 2. 改提示词是一次"实验"，app 和脚本必须用同一份，否则实验结论对 app 无效。
 *
 * 这里不许出现任何 import：Node 的 `--experimental-strip-types` 只能剥类型，不解析 `@/` 别名。
 *
 * ⚠️ 改这个文件 = 改 app 的生成行为。改完跑 `npm run build` + `tests/e2e/test-reading.mjs`。
 */

export type ArticleLevel = 'cet4' | 'cet6' | 'kaoyan' | 'ielts'

/**
 * 一档难度的**可量化规格**。
 *
 * 数字来自 2023 年四六级与考研英语二阅读真题的实测（四级 5 篇 / 六级 6 篇 / 英语二 5 篇，
 * 逐篇指标见 `词迹-生成难度偏差分析.md`）。四条经验：
 *
 * 1. **平均句长不能当唯一判据**，真题的真实形状是「短句 + 中句 + 少量长句」的三段式：
 *    四级每篇约 18 句 = 5 句短句（≤12 词）+ 3 句 ≥30 词 + 其余中句，句长标准差 8~10。
 *    只压平均句长，模型会把所有句子写成同一个长度（实测标准差只有 2.4，0 句超过 21 词），
 *    读起来平得不像真题——所以 `shortSents` / `veryLong` / `longFrom` 三个数字必须一起给。
 * 2. 篇幅区分「四级 vs 六级+」：四级 345 词，六级 447 词，考研 407 词。
 * 3. **名词化与被动在各档之间几乎没有差别**（真题 2.1~3.5/百词、被动 5.8%~19.8%），
 *    所以它们是 `forbid` 里的限额，不随档位升级——一旦写成「允许/适度」，
 *    模型会当成目标去追，实测密度翻 2~3 倍，这是「六级考研读起来偏难」的主因。
 * 4. 真题是**信息型说明文**（有年代、有例子、有对比），不是抽象说理文；提示词必须要求写事实。
 */
export interface LevelSpec {
  /** 难度定位（界面上那句人话） */
  label: string
  /** 正文词数区间 */
  words: [number, number]
  /** 平均句长区间（词/句） */
  avgSentence: [number, number]
  /** 单句词数上限 */
  maxSentence: number
  /** 长句门槛：单句多少词算「长句」 */
  longFrom: number
  /** 至少几句要超过 longFrom（长句尾巴，四级也要有） */
  veryLong: number
  /** 至少几句要不超过 12 词（真题里短句很多，全写长句反而不像） */
  shortSents: number
  /** 段落数区间 */
  paragraphs: [number, number]
  /** 该档允许的句法上限 */
  syntax: string
  /** 该档明确禁止的结构 */
  forbid: string
  /**
   * 长句示例（照这个密度写，不是照抄内容）。
   * 实测只描述结构（「主干 + which 从句 + 分词短语」）时，模型一句 30 词以上都写不出来；
   * 给一条现成的长句当标尺，比再写三条形容词有效。
   */
  longExample: string
}

export const LEVEL_SPEC: Record<ArticleLevel, LevelSpec> = {
  cet4: {
    label: '大学英语四级：词句平实，少用复杂从句',
    words: [300, 360],
    avgSentence: [18, 21],
    maxSentence: 45,
    longFrom: 30,
    veryLong: 3,
    shortSents: 5,
    paragraphs: [5, 5],
    syntax:
      '以简单句和并列句为主；从句最多一层（一个定语从句或一个状语从句），不叠加；' +
      '可以有被动语态和 there be 句式（真题里这两种很常见）；' +
      '但每篇必须有几句 30 词以上的长句——真题每篇约 3 句，靠「主干 + 一个定语从句 + 一个状语短语」搭出来，不要通篇 15 词的小短句',
    forbid:
      '禁止倒装、独立主格、虚拟语气、多层嵌套从句；单句不得超过 45 词，也不许一句话连挂三个以上介词短语；' +
      '禁止把所有句子写成同一个长度（15~20 词一路到底）',
    longExample:
      'The habit of quitting early, which many students develop in their first year of college, ' +
      'often survives into graduate study, quietly shaping daily choices long after the original fear has faded away.',
  },
  cet6: {
    label: '大学英语六级：有一定句式变化，允许抽象表达',
    words: [400, 460],
    avgSentence: [18, 22],
    maxSentence: 42,
    longFrom: 30,
    veryLong: 2,
    shortSents: 4,
    paragraphs: [4, 4],
    syntax:
      '允许两层结构（定语从句 + 状语从句，或分词短语作状语）；可以出现抽象名词，' +
      '但名词化表达每百词不超过 4 次，不要通篇抽象名词',
    forbid:
      '禁止通篇短句；单句不得超过 42 词；被动语态不超过 15% 的句子；' +
      '避免口语化缩略（gonna / kinda / 大量缩写）',
    longExample:
      'The habit of quitting early, which many students develop in their first year of college, ' +
      'often survives into graduate study, quietly shaping daily choices long after the original fear has faded away.',
  },
  /**
   * 考研：以**英语二**的实测为准（2023 英语二 Text 1/Text 2 等，共 5 篇）。
   * 之所以不再分英一/英二：实测两档在句法指标上分不开（avg 23.6 vs 24.1，p90 都是 39），
   * 差别在词汇难度与话题抽象度，而这两项提示词约束不住。
   */
  kaoyan: {
    label: '考研英语：长句为主、从句嵌套，但结构要清楚',
    words: [380, 440],
    avgSentence: [23, 26],
    maxSentence: 48,
    longFrom: 35,
    veryLong: 3,
    shortSents: 2,
    paragraphs: [4, 4],
    syntax:
      '以「长句但结构清楚」为主：允许一层定语从句 + 一层状语从句、非谓语短语作后置定语；' +
      '至少 1 处非限制性定语从句（, which …）或破折号补充说明；名词化每百词不超过 4 次',
    forbid:
      '禁止三层以上嵌套、禁止连续插入语；单句不得超过 48 词；被动语态不超过 15% 的句子；' +
      '禁止通篇长句——每 5 句至少留 1 句不超过 15 词用来换气',
    longExample:
      'The habit of quitting early, which many students develop during their first year on campus, ' +
      'often survives into graduate study and their later careers, quietly shaping daily choices long after the fear that first produced it has faded away.',
  },
  // 新生成已不可选（LEVELS 里没有它），保留只为老文章能显示档位
  ielts: {
    label: '雅思学术类阅读：学术语域，客观严谨，多用名词化表达',
    words: [320, 400],
    avgSentence: [20, 26],
    maxSentence: 40,
    longFrom: 35,
    veryLong: 2,
    shortSents: 2,
    paragraphs: [4, 4],
    syntax: '学术语域：名词化表达、客观陈述、被动语态适度使用',
    forbid: '禁止口语化与情绪化表达',
    longExample:
      'The habit of quitting early, which many students develop during their first year on campus, ' +
      'often survives into graduate study and their later careers, quietly shaping daily choices long after the fear that first produced it has faded away.',
  },
}

export const LEVEL_LABEL: Record<ArticleLevel, string> = {
  cet4: '四级',
  cet6: '六级',
  kaoyan: '考研',
  ielts: '雅思',
}

/**
 * 一篇文章最多塞多少个目标词。太多会变成"词表拼文章"，模型也覆盖不住。
 *
 * 放在这个零依赖模块里，是为了让 store/prefs.ts 能直接引用而不用拉进
 * domain/article.ts（后者依赖 api 与 store，会让偏好层变重）。
 */
export const MAX_TARGET_WORDS = 25

/** 生成页可选的词数上限档位（顺序即界面上的展示顺序） */
export const WORD_LIMITS: number[] = [10, 15, 20, MAX_TARGET_WORDS, 30]

export type ChatMessage = { role: 'system' | 'user'; content: string }

export interface OutlineParagraph {
  idea: string
  link?: string
  words: string[]
}

export interface Outline {
  topic: string
  paragraphs: OutlineParagraph[]
}

/** 提示词版本：出问题时先看这个，确认是不是提示词改动引起的 */
export const PROMPT_VERSION = 'v6-2026-11-11-distribution'

/** 把规格渲染成人能读的几条硬指标，两个阶段共用 */
function specLines(spec: LevelSpec, detailed: boolean): string[] {
  const [wMin, wMax] = spec.words
  const [aMin, aMax] = spec.avgSentence
  const [pMin, pMax] = spec.paragraphs

  const pMid = Math.round((pMin + pMax) / 2)
  const wPerMin = Math.round(wMin / pMid)
  const wPerMax = Math.round(wMax / pMid)
  const paraText = pMin === pMax ? `${pMid}` : `${pMin}~${pMax}`

  // 篇幅靠「每段几句 × 每段多少词」压住——v5 提示词就是靠这一行把篇幅写够的；
  // 只给全篇总词数时模型经常只写到六成（实测 cet4 242 / 300）。
  // 长句只给「标尺示例」（detailed 里那行），不写数字配额：写了配额它会为了凑数把中句拉长，
  // 平均句长反而失控（实测考研档冲到 29 词/句、短句归零）。
  const aMid = (aMin + aMax) / 2
  const sPerMin = Math.max(3, Math.floor(wPerMin / aMid))
  const sPerMax = Math.max(sPerMin + 1, Math.ceil(wPerMax / aMid))

  const lines = [
    `- 分段：共 ${paraText} 段，每段 ${sPerMin}~${sPerMax} 句、${wPerMin}~${wPerMax} 词` +
      `（合计 ${wMin}~${wMax} 词，写不够就逐段补论据）`,
    `- 平均句长 ${aMin}~${aMax} 词/句，单句不超过 ${spec.maxSentence} 词`,
  ]

  if (detailed) {
    if (spec.veryLong > 0) {
      lines.push(
        `- 那几句长句要真的带结构，不是把中句硬拉长：用「主干 + which 引导的非限制性定语从句 + 分词短语作状语」，` +
          `或「主干 + 插入语 + while 引导的让步状语」`,
        `- 长句标尺（照这个长度和密度写，不要照抄内容）：「${spec.longExample}」`,
      )
    }
    lines.push(`- 句法：${spec.syntax}`)
    // forbid 里本来就以「禁止」打头，这里再挂一次标签会读成「禁止：禁止倒装」
    lines.push(`- 禁止：${spec.forbid.replace(/^禁止/, '')}`)
  } else {
    lines.push(`- 句法：${spec.syntax}`)
  }

  return lines
}

/* ── 第一步：先列提纲 ─────────────────────── */

export function buildOutlineMessages(words: string[], level: ArticleLevel): ChatMessage[] {
  const spec = LEVEL_SPEC[level]

  const system =
    '你是一位资深的英语命题专家。你最重要的原则是：一篇好文章不是把指定词汇挨个造句再排列起来，' +
    '而是先有一个真正想说的论点，词汇只是恰好出现在论证路径上。'

  const user = [
    '一位学生今天需要复习下面这些单词：',
    words.join(', '),
    '',
    '请先设计一篇英语短文的写作提纲。要求：',
    `1. 难度定位：${spec.label}`,
    ...specLines(spec, false).map((l) => `   ${l}`),
    '2. 先想一个具体、可展开的论点（不要选过于宽泛的「技术很重要」这类空话）',
    '3. 段落之间必须有明确的逻辑推进——递进、转折或因果，不允许各段并列',
    '4. 每段给出：核心论点句（topic sentence）+ 承接关系（这段如何承接上一段）+ 该段用哪些词',
    '5. 把每个单词分配到最合适的一段，一个词只分配一次。判断标准是「这个词能不能自然地出现在该段的论证里」，',
    '   而不是「哪一段还没用满」。实在融不进论证的词，统一放到最后一段的收束句里带过',
    '',
    '只输出 JSON，不要任何解释：',
    '{"topic":"一句话说明文章主题与核心论点","paragraphs":[{"idea":"这一段的核心论点句","link":"如何承接上一段（第一段写「开篇」）","words":["该段用到的词"]}]}',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/* ── 第二步：按提纲成文 ───────────────────── */

export function buildArticleMessages(
  words: string[],
  level: ArticleLevel,
  outline: Outline | null,
): ChatMessage[] {
  const spec = LEVEL_SPEC[level]

  const system = [
    '你是一位资深的英语命题专家。你最重要的原则：好文章不是把指定词汇挨个造句再排列起来，',
    '而是先有一个真正想说的论点，词汇只是恰好出现在论证路径上。',
  ].join('')

  const [wMin] = spec.words
  const parts = [`请用下面这些单词写一篇英语短文。`, '', `【必须包含的单词】`, words.join(', '), '']

  if (outline) {
    parts.push(`【已确定的写作提纲】`, `主题与论点：${outline.topic}`)
    outline.paragraphs.forEach((p, i) => {
      const ws = p.words.length > 0 ? `（该段用：${p.words.join(', ')}）` : ''
      const link = p.link ? `〔承接：${p.link}〕` : ''
      parts.push(`第 ${i + 1} 段：${p.idea}${link}${ws}`)
    })
    parts.push('')
  }

  parts.push(
    `【要求】`,
    `1. 难度：${spec.label}`,
    ...specLines(spec, true).map((l) => `   ${l}`),
    `2. 严格按上面的「分段 + 句子配比」写。少于 ${Math.max(0, wMin - 20)} 词视为不合格，必须逐段补到够`,
    outline
      ? `3. 严格按提纲展开，段落顺序和论点不要改；提纲里的「承接」必须落实为真实的过渡句`
      : `3. 段落之间用递进/转折/因果连接，不允许并列罗列`,
    `4. 上面每一个单词都必须在正文中出现至少一次，原形或变形均可`,
    ``,
    `【写作红线】`,
    `- 禁止逐词造句再拼接：每个段落必须围绕该段的中心论点展开，段内的句子要互相支撑`,
    `- 代词必须有明确的指代对象；However / Therefore 这类衔接词必须存在真实的逻辑关系，不是装饰`,
    `- 自查标准：把目标单词全部拿掉，剩下的文字仍然是一篇逻辑通顺的文章——达不到就重写`,
    `- 要写事实，不要通篇抽象判断：至少给出 1 处具体场景（谁在什么场合做什么）、1 处年代或地域范围、` +
      `1 处对比（过去/现在、城市/乡村、A 地与 B 地）。考试阅读是信息型说明文，不是散文`,
    `- 但不许编造：具体统计数字、机构名、人名、研究结论都不要虚构。需要举例时用「一些城市」「多项调查」` +
      `这类概括说法——注意概括说法不能顶替全部论据，事实该占的篇幅还得占`,
    `- 每个目标词都要落在论证里：它必须出现在支撑该段论点的句子中。` +
      `若某个词与主题天然无关，就用一个顺势带过的从句处理，不要为它单独造比喻或场景`,
    ``,
    `【交付前自查】`,
    `- 逐段数：这一段几句？加起来够不够每段的句数下限`,
    `- 逐段数字数：每段是否达到每段词数下限；不够就补论据，不要靠加形容词凑`,
    `- 数总词数，确认落在 ${spec.words[0]}~${spec.words[1]} 之间`,
    `- 检查最长的一句是否超过 ${spec.maxSentence} 词，超了就拆`,
    ``,
    `【输出格式】`,
    `只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字：`,
    `{"title":"英文标题","titleZh":"标题的中文翻译","sentences":[{"en":"英文句子","zh":"这句话的中文翻译"}]}`,
    ``,
    `注意：sentences 数组要把正文按句子切开，一句一项，英文和中文一一对应。`,
  )

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ]
}
