import { dictHas } from '@/data/dict'

/**
 * 一个原形的常见变形，供点词时切换查看。
 *
 * 为什么需要它：墨墨词库里收的是原形（`shipment`），而文章里出现的是变形
 * （`Shipments`）。定位到原形之后，把同族的几个形式摆出来，用户可以自己换着看，
 * 也免得「明明在墨墨里背过，却显示没有」这种困惑。
 *
 * 纯本地：规则生成 + 本地词典过滤，不消耗任何 API 请求。
 */

export type Pos = 'n' | 'v' | 'adj' | 'other'

/** 从释义前缀猜词性：本地词典的格式是「n. 装船…」「v. 放弃…」 */
export function posFromGloss(gloss: string | null | undefined): Pos {
  if (!gloss) return 'other'
  const head = gloss.trim().slice(0, 6).toLowerCase()
  if (/^n\./.test(head)) return 'n'
  if (/^v\./.test(head)) return 'v'
  if (/^adj\./.test(head)) return 'adj'
  if (/^adv\./.test(head)) return 'other'
  return 'other'
}

function plural(w: string): string {
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(w)) return `${w}es`
  if (/[^aeiou]o$/.test(w)) return `${w}es`
  return `${w}s`
}

function thirdPerson(w: string): string {
  if (/(s|x|z|ch|sh|o)$/.test(w)) return `${w}es`
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`
  return `${w}s`
}

function gerund(w: string): string {
  if (w.endsWith('ie')) return `${w.slice(0, -2)}ying`
  if (w.endsWith('e') && !/(ee|ye|oe)$/.test(w)) return `${w.slice(0, -1)}ing`
  return `${w}ing`
}

function past(w: string): string {
  if (w.endsWith('e')) return `${w}d`
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ied`
  return `${w}ed`
}

function comparative(w: string, suffix: 'er' | 'est'): string {
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}i${suffix}`
  if (w.endsWith('e')) return `${w}${suffix.slice(1)}`
  return `${w}${suffix}`
}

/** 按词性给出候选（还没过滤，可能有假词） */
function generate(base: string, pos: Pos): string[] {
  switch (pos) {
    case 'n':
      return [plural(base)]
    case 'v':
      return [thirdPerson(base), gerund(base), past(base)]
    case 'adj':
      return [comparative(base, 'er'), comparative(base, 'est')]
    default:
      return [plural(base), gerund(base), past(base)]
  }
}

/**
 * 同一家族的常见形式：原形在最前，后面是本地词典里真实存在的变形。
 * 词典里查不到的假词（boxe / cas 这类）会被过滤掉。
 */
export async function inflectionFamily(
  base: string,
  gloss: string | null | undefined,
  /** 始终纳入的形式，通常是用户点到的那个词（它一定真实存在） */
  also: string[] = [],
  max = 5,
): Promise<string[]> {
  const root = base.trim().toLowerCase()
  if (!root) return []

  const out = [root, ...also.map((w) => w.trim().toLowerCase()).filter((w) => w && w !== root)]
  for (const form of generate(root, posFromGloss(gloss))) {
    if (out.length >= max) break
    if (out.includes(form)) continue
    if (await dictHas(form)) out.push(form)
  }
  return out
}
