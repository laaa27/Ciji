import React from 'react'
import ReactDOM from 'react-dom/client'

import '@fontsource/spectral/400.css'
import '@fontsource/spectral/500.css'
import './ui/styles/tokens.css'
import './ui/styles/global.css'

import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
