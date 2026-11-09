import { useGlass, GLASS_ALPHA_MIN, GLASS_ALPHA_MAX } from '@/store/glass'
import { useTheme, type ThemeName } from '@/store/theme'

import styles from '../../pages/SettingsPage.module.css'

/**
 * 设置二级页：外观。
 * 原来页面上有两个「外观」section（主题、玻璃各一个），拆页时合并成一处。
 */
export default function AppearancePrefs() {
  const theme = useTheme((s) => s.theme)
  const setTheme = useTheme((s) => s.setTheme)
  const glass = useGlass((s) => s.glass)
  const setGlass = useGlass((s) => s.setGlass)
  const glassAlpha = useGlass((s) => s.alpha)
  const setGlassAlpha = useGlass((s) => s.setAlpha)

  return (
    <>
      <section className={styles.section}>
        <h2 className={styles.label}>主题</h2>

        <div className={styles.segments}>
          {(['light', 'dark'] as ThemeName[]).map((name) => (
            <button
              key={name}
              type="button"
              className={styles.segment}
              data-on={theme === name}
              onClick={() => void setTheme(name)}
            >
              {name === 'light' ? '白天' : '深夜'}
            </button>
          ))}
        </div>

        <p className={styles.help}>深夜主题换的是整套纸墨色，不是把白天反色。</p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.label}>液态玻璃底栏</h2>

        <label className={styles.switchRow}>
          <span className={styles.switchText}>
            液态玻璃底栏
            <em>
              底栏变成悬浮的半透明玻璃胶囊，滚动内容从栏下透出模糊的质感。滚动觉得费劲就关掉。
            </em>
          </span>
          <input
            type="checkbox"
            className={styles.switch}
            checked={glass}
            onChange={(e) => void setGlass(e.target.checked)}
          />
        </label>

        <div className={styles.sliderRow} data-disabled={!glass}>
          <span className={styles.switchText}>
            玻璃不透明度
            <em>越低越透，滚动的文字越看得清。</em>
          </span>
          <span className={styles.sliderValue}>{Math.round(glassAlpha * 100)}%</span>
          <input
            type="range"
            className={styles.slider}
            min={GLASS_ALPHA_MIN}
            max={GLASS_ALPHA_MAX}
            step={0.05}
            value={glassAlpha}
            disabled={!glass}
            onChange={(e) => void setGlassAlpha(Number(e.target.value))}
          />
        </div>
      </section>
    </>
  )
}
