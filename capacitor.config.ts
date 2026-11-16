import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.laaa27.maimemo',
  appName: '词迹',
  webDir: 'dist',
  android: {
    // WebView 背景与纸色一致，避免冷启动白闪
    backgroundColor: '#F7F8F5',
  },
}

export default config
