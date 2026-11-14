import React from 'react'
import ReactDOM from 'react-dom/client'

import '@fontsource/spectral/400.css'
import '@fontsource/spectral/500.css'
import './ui/styles/tokens.css'
import './ui/styles/global.css'

import App from './App'
import { setGlossModelProvider } from '@/domain/lookup'
import { useLlm } from '@/store/llm'

/*
 * 组合根注入：查词编排在 domain 层，它不该直接读 store（否则又是一条反向依赖）。
 * 这里把「用哪个模型查释义」的来源交进去，与 api/client 的
 * setTokenProvider 是同一套做法。放在模块顶层而不是 effect 里——
 * 首屏的今日页词表可能先于任何 effect 触发查词。
 */
setGlossModelProvider(() => {
  const state = useLlm.getState()
  const profile = state.glossActive()
  return profile ? { profile } : null
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
