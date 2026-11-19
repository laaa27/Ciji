import { useTheme } from '@/store/theme'

type Props = {
  /** 按钮外形跟着宿主走：阅读页头部和做题页工具栏都用各自那套小字按钮样式 */
  className?: string
}

/**
 * 主题切换：一颗文字按钮「主题」，点一下白天 / 深夜互换。
 *
 * 不画图标、不写字面状态 —— 当前是哪个主题，整个屏幕本身就是最直接的提示；
 * 按钮上再标「白天 / 深夜」只会跟旁边的「译文 / 字号」抢注意力。
 * 状态走 useTheme，与设置 → 外观同源，两处天然同步。
 */
export default function ThemeToggle({ className }: Props) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        const { theme, setTheme } = useTheme.getState()
        void setTheme(theme === 'dark' ? 'light' : 'dark')
      }}
    >
      主题
    </button>
  )
}
