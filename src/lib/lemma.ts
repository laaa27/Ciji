/**
 * 词形还原：按常见后缀反推原形。
 *
 * 放在 `lib/` 而不是 `data/`：它是**纯字符串规则**，不碰存储也不发请求，
 * 任何层都能用。原先住在 `data/dict.ts` 里，那个文件同时承担查词、缓存、编排
 * 三件事，改一处要读大半个文件。
 */

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
  torn: 'tear', tore: 'tear', begun: 'begin', began: 'begin',
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
 * **顺序就是可信度**：越可靠的规则排得越前，调用方（查词、墨墨状态、文章覆盖）
 * 一律按顺序取第一个命中的，不要拿「原词 + 全部猜测」当集合用 —— 集合没有优先级，
 * 猜出来的原形会冒充用户点的那个词。
 *
 * 规则必须带前置条件，不能见后缀就剥：
 * - `sites` 是 site **+s**，剥两个字母会得到 `sit`（真题词），释义和墨墨状态全错；
 * - `files` 同理，剥两个字母是 `fil`（伊拉克钱币）；
 * - `filing` 的来源是 `file` 去 e 加 ing，不是 `fil`。
 * 这三条都曾经真实发生过，见 `tests/e2e/verify-word-forms.mjs` 的负例断言。
 *
 * 所有格（pharaoh's / students'）单独处理：墨墨词库与 ECDICT 都只收原形，
 * 不剥撇号的话文章里的 `pharaoh's` 会「查不到释义、加不进词库、被判定为未使用」——
 * 三个症状同源。
 */
export function lemmaCandidates(word: string): string[] {
  // 排版里的撇号是 U+2019（’），词表里的通常是 U+0027（'）。不归一化的话
  // 同一个词会分成两个键，缓存与墨墨查询都会各查一遍还都查不到。
  const w = word.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'")
  const out: string[] = [w]
  const add = (s: string) => {
    if (s.length >= 2 && !out.includes(s)) out.push(s)
  }

  // 所有格与缩写词尾：pharaoh's → pharaoh；students' → students → student。
  // 先递归还原剥掉撇号后的词，带撇号的复数才不会只停在 `students` 这一层。
  if (w.endsWith("'s")) {
    for (const c of lemmaCandidates(w.slice(0, -2))) add(c)
  } else if (w.endsWith("'")) {
    for (const c of lemmaCandidates(w.slice(0, -1))) add(c)
  }

  // ── 复数 / 三单：三种形态互斥，各带前置条件 ──
  // -ies 只可能来自 -y（studies → study）
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y')
  /*
   * 纯 -s 排在 -es 之前：以 e 结尾的词是 +s（sites → site、uses → use、
   * notes → note），剥两个字母会落到另一个真实单词上（sit / us / not）。
   * -es 只在词干确实以 s/x/z/ch/sh 结尾时才成立（boxes → box、watches → watch、
   * abacuses → abacus），那时 -s 的结果（boxe / watche）本来就是假词，不影响排序。
   * 带撇号的词已经由上面剥过一次，别在这里再削出一个 `pharaoh'`
   */
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith("'s")) add(w.slice(0, -1))
  if (w.endsWith('es') && /(s|x|z|ch|sh)$/.test(w.slice(0, -2))) add(w.slice(0, -2))
  // analyses → analysis（`-es` 只能得到 analys，补一条 -is）
  if (w.endsWith('ses')) add(w.slice(0, -2) + 'is')
  // wives → wife / leaves → leaf / knives → knife
  if (w.endsWith('ves')) {
    add(w.slice(0, -3) + 'f')
    add(w.slice(0, -3) + 'fe')
  }

  // 不规则复数
  const irregular = IRREGULAR[w]
  if (irregular) add(irregular)

  // ── -ed / -ing：先试「补回词尾 e」，再试裸词干 ──
  // filed 更可能来自 file（file+d）而不是 fil；filing 同理（file 去 e 加 ing）。
  // 裸词干排在后面是因为 asking → ask 这类只能靠它兜底（aske 不是词，
  // 调用方查不到自然会跳过）。
  if (w.endsWith('ed')) {
    const stem = w.slice(0, -2) // filed → fil
    const doubled = isDoubled(stem) // stopped → stopp
    if (!doubled && !stem.endsWith('e')) add(w.slice(0, -1)) // file
    add(stem)
    if (doubled) add(stem.slice(0, -1)) // stop
    // studied → studi → study
    if (stem.endsWith('i')) add(stem.slice(0, -1) + 'y')
  }
  if (w.endsWith('ing')) {
    const stem = w.slice(0, -3) // filing → fil
    const doubled = isDoubled(stem) // running → runn
    // see / agree 这类词干本身以 e 结尾的，不能再补一个 e
    if (!doubled && !stem.endsWith('e')) add(stem + 'e') // file / make
    add(stem) // ask / read
    if (doubled) add(stem.slice(0, -1)) // run
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

/** 词干是不是以双写辅音结尾（stopp / runn）—— 那种情况原形要去掉一个 */
function isDoubled(stem: string): boolean {
  return stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2] && /[bcdfghjklmnpqrstvwxz]/.test(stem[stem.length - 1])
}

/**
 * 归一化后的原词：`lemmaCandidates` 的第一项。
 *
 * 拆出来是为了让调用方能明确区分「这是用户点的词本身」和「这是猜出来的原形」——
 * 墨墨查询、展示文案都必须按这个界限分开写。
 */
export function exactForm(word: string): string {
  return lemmaCandidates(word)[0]
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
