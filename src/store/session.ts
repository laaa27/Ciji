import { Preferences } from '@capacitor/preferences'
import { create } from 'zustand'

import { setTokenProvider } from '@/api/client'

const KEY = 'maimemo_token'

type SessionState = {
  token: string | null
  /** 是否已从本地读完，避免首屏误判为「未配置」 */
  ready: boolean
  load: () => Promise<void>
  saveToken: (raw: string) => Promise<void>
  clearToken: () => Promise<void>
}

export const useSession = create<SessionState>((set) => ({
  token: null,
  ready: false,

  load: async () => {
    const { value } = await Preferences.get({ key: KEY })
    set({ token: value?.trim() || null, ready: true })
  },

  saveToken: async (raw) => {
    const value = raw.trim()
    if (!value) return
    await Preferences.set({ key: KEY, value })
    set({ token: value })
  },

  clearToken: async () => {
    await Preferences.remove({ key: KEY })
    set({ token: null })
  },
}))

// 让 api 层能拿到最新 token，而不用反向依赖 store
setTokenProvider(() => useSession.getState().token)
