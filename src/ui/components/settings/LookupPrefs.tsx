import { useEffect, useState } from 'react'

import { isOnlineLookupEnabled, saveOnlineLookup } from '@/data/dict'

import styles from '../../pages/SettingsPage.module.css'

/**
 * 设置二级页：查词与释义。
 * 联网补查开关——说明里写清完整优先级链，用户才知道这个开关影响的是哪一层。
 */
export default function LookupPrefs() {
  const [online, setOnline] = useState(isOnlineLookupEnabled())

  useEffect(() => {
    setOnline(isOnlineLookupEnabled())
  }, [])

  async function handleToggleOnline(next: boolean) {
    setOnline(next)
    await saveOnlineLookup(next)
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.label}>联网补查</h2>

      <label className={styles.switchRow}>
        <span className={styles.switchText}>
          联网补查
          <em>
            查词顺序：本地词库 → AI 释义（大模型）→ 联网补查。本地词条最全最快，AI 释义更细致，
            联网补查是免费在线翻译，查过的会存下来，不会重复请求。
            未配置大模型 API 时，联网补查仍然可用，作为最后的兜底方案。
          </em>
        </span>
        <input
          type="checkbox"
          className={styles.switch}
          checked={online}
          onChange={(e) => void handleToggleOnline(e.target.checked)}
        />
      </label>

      <p className={styles.help}>
        关掉后只查本地词库和 AI 释义，适合想省流量或完全离线使用的场景。
      </p>
    </section>
  )
}
