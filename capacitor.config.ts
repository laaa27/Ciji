import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.laaa27.maimemo',
  appName: '词迹',
  webDir: 'dist',
  android: {
    // WebView 背景与纸色一致，避免冷启动白闪
    backgroundColor: '#F7F8F5',
    // 临时打开：真机验证文章文件迁移（原生 Filesystem），验证完删掉
    webContentsDebuggingEnabled: true,
  },
}

export default config
