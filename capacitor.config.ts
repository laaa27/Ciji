import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.laaa27.maimemo',
  appName: '词迹',
  webDir: 'dist',
  android: {
    // WebView 背景与纸色一致，避免冷启动白闪
    backgroundColor: '#F7F8F5',
  },
  plugins: {
    // 放开 Capacitor 对返回键的占用：
    // - 子视图（文章库/生成页/词卡）打开时由 PredictiveBackPlugin 接管（跟手动画）
    // - 根层级不拦截，系统播预测性「返回主页」动画，松手 app 退后台
    App: { disableBackButtonHandler: true },
  },
}

export default config
