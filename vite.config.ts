import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  // Capacitor 从 file:// 加载，必须用相对路径
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      // 墨墨 API 无 CORS 头，开发时走代理；真机由 CapacitorHttp 直连
      '/open': {
        target: 'https://open.maimemo.com',
        changeOrigin: true,
        secure: true,
      },
      '/llm/zhipu': {
        target: 'https://open.bigmodel.cn',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/llm\/zhipu/, '/api/paas/v4'),
      },
      '/llm/deepseek': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/llm\/deepseek/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
})
