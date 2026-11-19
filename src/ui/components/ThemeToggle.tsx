import { useTheme } from '@/store/theme'

import styles from './ThemeToggle.module.css'

/**
 * 太阳的八道射线。半径 5.3 → 7.0（viewBox 16 的坐标系），每 45° 一道，
 * 圆头由 stroke-linecap 负责 —— 这也是它没法用 CSS 渐变画的原因：
 * 渐变只有硬边，末端一定是方的，缩小后像准星。
 */
const RAYS = [
  [13.3, 8, 15, 8],
  [11.75, 11.75, 12.95, 12.95],
  [8, 13.3, 8, 15],
  [4.25, 11.75, 3.05, 12.95],
  [2.7, 8, 1, 8],
  [4.25, 4.25, 3.05, 3.05],
  [8, 2.7, 8, 1],
  [11.75, 4.25, 12.95, 3.05],
]

/**
 * 白天 / 深夜的切换键。
 *
 * 图标画的是**当前模式**（白天是个太阳、深夜是弯月亮）—— 看到什么就是现在是什么，
 * 与设置页「外观」里那枚开关说的是同一件事。状态走 useTheme，两处天然同步。
 *
 * 按钮**不画边框**：那个方框只用来定住图标的尺寸与点按范围（两处吸顶都用同一颗）。
 * 图标本身 13px —— 和旁边的 11px 小字、22px 计时数字放在一行才不显突兀。
 */
export default function ThemeToggle() {
  const theme = useTheme((s) => s.theme)
  const next = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      type="button"
      className={styles.btn}
      onClick={() => void useTheme.getState().setTheme(next)}
      aria-label={next === 'dark' ? '切换到深夜模式' : '切换到白天模式'}
    >
      <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {theme === 'light' ? (
          <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <circle cx="8" cy="8" r="3.1" />
            {RAYS.map(([x1, y1, x2, y2]) => (
              <line key={`${x1}-${y1}`} x1={x1} y1={y1} x2={x2} y2={y2} />
            ))}
          </g>
        ) : (
          // 弯月：一段外弧 + 一段内弧合起来（Feather 那枚 moon 的轮廓）
          <path fill="currentColor" d="M14.2 9.9A6.2 6.2 0 1 1 6.6 1.9a5 5 0 0 0 7.6 8z" />
        )}
      </svg>
    </button>
  )
}
