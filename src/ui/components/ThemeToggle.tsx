import { useTheme } from '@/store/theme'

import styles from './ThemeToggle.module.css'

type Props = {
  /** 按钮本身长得像什么由调用方决定（文字按钮 / 方框按钮），这里只管画图标 */
  className?: string
}

/**
 * 白天 / 深夜的切换键。
 *
 * 图标画的是**当前模式**（白天是个太阳、深夜是弯月亮）。选这个语义是因为它和
 * 设置页「外观」里那枚开关说的是同一件事 —— 看到什么就是现在是什么，不用反着想。
 *
 * 状态走 useTheme，与设置页同源：这里点了，设置页的开关立刻跟着变，反之亦然。
 * 图标是 CSS 画的（不引图标库）：太阳＝四道短射线 + 实心圆，月亮＝内阴影切出来的弯钩。
 */
export default function ThemeToggle({ className }: Props) {
  const theme = useTheme((s) => s.theme)
  const next = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      type="button"
      className={className}
      onClick={() => void useTheme.getState().setTheme(next)}
      aria-label={next === 'dark' ? '切换到深夜模式' : '切换到白天模式'}
    >
      <span className={styles.icon} data-kind={theme} aria-hidden="true" />
    </button>
  )
}
