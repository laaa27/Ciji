import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string }

/**
 * 构建号（versionCode）只有 build.gradle 里有，而「关于」页要把它显示出来。
 *
 * 这里读一次注进界面，不让它在两处各写一份 —— 0.22.0 那次「已是最新仍提示更新」
 * 就是版本字面量各写一份、其中一份忘了改造成的。
 * 读不到原生工程（比如只 checkout 了 src）就退回空串，界面显示「—」，不编一个假的。
 */
function readVersionCode(): string {
  try {
    const gradle = readFileSync(
      fileURLToPath(new URL('./android/app/build.gradle', import.meta.url)),
      'utf-8',
    )
    return /versionCode\s+(\d+)/.exec(gradle)?.[1] ?? ''
  } catch {
    return ''
  }
}

/**
 * 开发期的 LLM 转发中间件。
 *
 * 为什么不能用静态 server.proxy：Base URL 是用户在设置里自己填的，
 * 构建期根本不知道目标主机。浏览器里跨域请求第三方 API 一定会被 CORS 拦，
 * 所以这里用 /__llm?url=<encoded> 把请求透传出去，只跑在 dev server，不进包。
 */
function llmProxy(): Plugin {
  return {
    name: 'llm-cors-proxy',
    configureServer(server) {
      server.middlewares.use('/__llm', async (req, res) => {
        const target = new URL(req.url ?? '', 'http://localhost').searchParams.get('url')
        res.setHeader('content-type', 'application/json; charset=utf-8')

        if (!target) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: { message: '缺少 url 参数' } }))
          return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks)

        const headers = { ...req.headers } as Record<string, string | undefined>
        for (const k of ['host', 'connection', 'content-length', 'origin', 'referer', 'accept-encoding']) {
          delete headers[k]
        }

        try {
          const upstream = await fetch(target, {
            method: req.method && req.method !== 'GET' ? req.method : 'POST',
            headers: headers as Record<string, string>,
            body,
          })

          res.statusCode = upstream.status
          upstream.headers.forEach((value, key) => {
            if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key)) {
              res.setHeader(key, value)
            }
          })
          res.end(Buffer.from(await upstream.arrayBuffer()))
        } catch (e) {
          res.statusCode = 502
          res.end(
            JSON.stringify({
              error: { message: e instanceof Error ? e.message : '转发失败，检查 Base URL' },
            }),
          )
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), llmProxy()],
  define: {
    // 版本号只在这里维护，界面直接读，避免和 build.gradle 各写一份
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_VERSION_CODE__: JSON.stringify(readVersionCode()),
  },
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
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
})
