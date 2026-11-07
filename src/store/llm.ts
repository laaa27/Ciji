import { Preferences } from '@capacitor/preferences'
import { create } from 'zustand'

export type LlmProvider = 'zhipu' | 'deepseek'

export interface ProviderMeta {
  name: string
  baseUrl: string
  model: string
  help: string
  /** 免费额度说明，显示在设置页 */
  pricing: string
}

export const PROVIDERS: Record<LlmProvider, ProviderMeta> = {
  zhipu: {
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    help: 'open.bigmodel.cn 注册后在「API Keys」里创建',
    pricing: '免费，每日百万 token',
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    help: 'platform.deepseek.com 注册后创建',
    pricing: '约 ¥0.5 / 百万 token',
  },
}

const K_PROVIDER = 'llm_provider'
const K_KEY = 'llm_key'
const K_MODEL = 'llm_model'

type LlmState = {
  provider: LlmProvider
  apiKey: string | null
  /** 留空则用服务商默认模型 */
  model: string
  ready: boolean

  load: () => Promise<void>
  save: (cfg: { provider: LlmProvider; apiKey: string; model?: string }) => Promise<void>
  clear: () => Promise<void>
}

export const useLlm = create<LlmState>((set) => ({
  provider: 'zhipu',
  apiKey: null,
  model: '',
  ready: false,

  load: async () => {
    const [p, k, m] = await Promise.all([
      Preferences.get({ key: K_PROVIDER }),
      Preferences.get({ key: K_KEY }),
      Preferences.get({ key: K_MODEL }),
    ])
    const provider = (p.value === 'deepseek' ? 'deepseek' : 'zhipu') as LlmProvider
    set({
      provider,
      apiKey: k.value?.trim() || null,
      model: m.value ?? '',
      ready: true,
    })
  },

  save: async ({ provider, apiKey, model }) => {
    const key = apiKey.trim()
    await Promise.all([
      Preferences.set({ key: K_PROVIDER, value: provider }),
      Preferences.set({ key: K_KEY, value: key }),
      Preferences.set({ key: K_MODEL, value: model?.trim() ?? '' }),
    ])
    set({ provider, apiKey: key || null, model: model?.trim() ?? '' })
  },

  clear: async () => {
    await Promise.all([
      Preferences.remove({ key: K_KEY }),
      Preferences.remove({ key: K_MODEL }),
    ])
    set({ apiKey: null, model: '' })
  },
}))

/** 当前生效的模型 id */
export function activeModel(state: Pick<LlmState, 'provider' | 'model'>): string {
  return state.model || PROVIDERS[state.provider].model
}
