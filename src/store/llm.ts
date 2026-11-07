import { Preferences } from '@capacitor/preferences'
import { create } from 'zustand'

import { normalizeBaseUrl, type LlmProtocol } from '@/api/protocols'

/**
 * 大模型配置：从「内置两个服务商 + 一个 key」改成「多份配置 + 切换」。
 *
 * 为什么是「配置列表」而不是「自定义服务商」：
 * 同一个厂商也可以配多份（比如 DeepSeek 官方 + 第三方中转），或者同厂商不同模型
 * （deepseek-chat 与 deepseek-reasoner 各有取舍）。列表模型天然支持这些，且切换只要一次点击。
 *
 * 存储：`llm_profiles` 一整份 JSON + `llm_active` 当前选中的 id。
 * 为什么不拆成多个 key：读的时候要一次拿全，拆开反而要 keys() + N 次读。
 */

export interface LlmProfile {
  id: string
  /** 显示名，用户可改（默认取厂商名） */
  name: string
  protocol: LlmProtocol
  /** 到版本段为止的根地址，路径由 protocols.ts 补 */
  baseUrl: string
  apiKey: string
  model: string
  createdAt: string
}

/** 新建时的模板，只用来预填表单，不再是「唯一可选项」 */
export interface LlmPreset {
  key: string
  name: string
  protocol: LlmProtocol
  baseUrl: string
  /** 留空表示让用户自己填（不猜模型名，猜错只会多一次 404） */
  model: string
  hint: string
}

export const PRESETS: LlmPreset[] = [
  {
    key: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    hint: '免费额度大，适合日常生成',
  },
  {
    key: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    hint: '约 ¥0.5 / 百万 token，可换 deepseek-reasoner',
  },
  {
    key: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    hint: '按量计费，模型名填你账号可用的，如 gpt-4o-mini',
  },
  {
    key: 'anthropic',
    name: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: '',
    hint: '走 /v1/messages，模型名如 claude-sonnet-4-5',
  },
  {
    key: 'custom',
    name: '自定义',
    protocol: 'openai',
    baseUrl: '',
    model: '',
    hint: '任何 OpenAI 兼容网关：one-api、new-api、LM Studio、Ollama 等',
  },
]

const K_PROFILES = 'llm_profiles'
const K_ACTIVE = 'llm_active'

// v0.5.0 及更早的键，仅用于迁移
const K_OLD_PROVIDER = 'llm_provider'
const K_OLD_KEY = 'llm_key'
const K_OLD_MODEL = 'llm_model'

function newId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function presetByKey(key: string): LlmPreset {
  return PRESETS.find((p) => p.key === key) ?? PRESETS[PRESETS.length - 1]
}

export function newProfile(preset: LlmPreset, patch: Partial<LlmProfile> = {}): LlmProfile {
  return {
    id: newId(),
    name: preset.name,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    apiKey: '',
    model: preset.model,
    createdAt: new Date().toISOString(),
    ...patch,
  }
}

/** 保存前的校验：宁可在这里拦下，也不要等用户点了「测试」才看到 404 */
export function validateProfile(p: {
  name: string
  baseUrl: string
  model: string
  apiKey: string
}): string | null {
  if (!p.name.trim()) return '给这个模型起个名字'
  if (!p.model.trim()) return '模型名不能为空'
  if (!p.apiKey.trim()) return 'API Key 不能为空'
  try {
    normalizeBaseUrl(p.baseUrl)
  } catch (e) {
    return e instanceof Error ? e.message : 'Base URL 不对'
  }
  return null
}

type LlmState = {
  profiles: LlmProfile[]
  activeId: string | null
  ready: boolean

  load: () => Promise<void>
  /** 新增；同 id 已存在则替换 */
  upsert: (profile: LlmProfile) => Promise<void>
  remove: (id: string) => Promise<void>
  setActive: (id: string) => Promise<void>
  /** 取当前生效的那份配置（读不到返回 null） */
  active: () => LlmProfile | null
}

async function persist(profiles: LlmProfile[], activeId: string | null): Promise<void> {
  await Promise.all([
    Preferences.set({ key: K_PROFILES, value: JSON.stringify(profiles) }),
    Preferences.set({ key: K_ACTIVE, value: activeId ?? '' }),
  ])
}

/** 旧版单 key 数据 → 一条配置；迁移完删掉旧键，避免重复迁移 */
async function migrateLegacy(): Promise<{ profiles: LlmProfile[]; activeId: string | null }> {
  const [provider, key, model] = await Promise.all([
    Preferences.get({ key: K_OLD_PROVIDER }),
    Preferences.get({ key: K_OLD_KEY }),
    Preferences.get({ key: K_OLD_MODEL }),
  ])

  const apiKey = key.value?.trim() ?? ''
  if (!apiKey) return { profiles: [], activeId: null }

  const preset = presetByKey(provider.value === 'deepseek' ? 'deepseek' : 'zhipu')
  const profile = newProfile(preset, {
    apiKey,
    model: model.value?.trim() || preset.model,
  })

  await Promise.all([
    Preferences.remove({ key: K_OLD_KEY }),
    Preferences.remove({ key: K_OLD_MODEL }),
    Preferences.remove({ key: K_OLD_PROVIDER }),
  ])

  return { profiles: [profile], activeId: profile.id }
}

function parseProfiles(raw: string | null): LlmProfile[] {
  if (!raw) return []
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data
      .map((item) => {
        const p = item as Partial<LlmProfile>
        if (!p || typeof p !== 'object') return null
        if (!p.id || !p.baseUrl || !p.apiKey) return null
        return {
          id: String(p.id),
          name: String(p.name ?? '未命名'),
          protocol: p.protocol === 'anthropic' ? 'anthropic' : 'openai',
          baseUrl: String(p.baseUrl),
          apiKey: String(p.apiKey),
          model: String(p.model ?? ''),
          createdAt: String(p.createdAt ?? new Date().toISOString()),
        } satisfies LlmProfile
      })
      .filter((p): p is LlmProfile => p !== null)
  } catch {
    return []
  }
}

export const useLlm = create<LlmState>((set, get) => ({
  profiles: [],
  activeId: null,
  ready: false,

  load: async () => {
    const [stored, activeRaw] = await Promise.all([
      Preferences.get({ key: K_PROFILES }),
      Preferences.get({ key: K_ACTIVE }),
    ])

    let profiles = parseProfiles(stored.value)
    let activeId = activeRaw.value?.trim() || null

    if (profiles.length === 0) {
      const migrated = await migrateLegacy()
      if (migrated.profiles.length > 0) {
        profiles = migrated.profiles
        activeId = migrated.activeId
        await persist(profiles, activeId)
      }
    }

    // activeId 指向已删除的配置时，退回第一条，不让界面处在「有模型但不可用」的状态
    if (!profiles.some((p) => p.id === activeId)) activeId = profiles[0]?.id ?? null

    set({ profiles, activeId, ready: true })
  },

  upsert: async (profile) => {
    const list = get().profiles
    const idx = list.findIndex((p) => p.id === profile.id)
    const isNew = idx < 0
    const next = isNew ? [...list, profile] : list.map((p) => (p.id === profile.id ? profile : p))

    // 新增即切过去 —— 刚配好一个模型，下一步就是想用它；
    // 编辑已有配置则保持当前选择不变，免得改个名字就把正在用的模型换掉
    const activeId = isNew ? profile.id : (get().activeId ?? profile.id)

    set({ profiles: next, activeId })
    await persist(next, activeId)
  },

  remove: async (id) => {
    const next = get().profiles.filter((p) => p.id !== id)
    const activeId = get().activeId === id ? (next[0]?.id ?? null) : get().activeId
    set({ profiles: next, activeId })
    await persist(next, activeId)
  },

  setActive: async (id) => {
    if (!get().profiles.some((p) => p.id === id)) return
    set({ activeId: id })
    await persist(get().profiles, id)
  },

  active: () => {
    const { profiles, activeId } = get()
    return profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null
  },
}))

/** 组件里用：当前生效的配置（响应 profiles / activeId 变化） */
export function useActiveProfile(): LlmProfile | null {
  return useLlm((s) => s.profiles.find((p) => p.id === s.activeId) ?? s.profiles[0] ?? null)
}
