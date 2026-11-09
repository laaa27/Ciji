import { useEffect, useState } from 'react'

import {
  fetchLatestRelease,
  isAutoCheckEnabled,
  isNewerVersion,
  setAutoCheckEnabled,
  type ReleaseInfo,
} from '@/domain/update'

import styles from '../../pages/SettingsPage.module.css'

/** 项目仓库地址，GitHub 上的开源主页 */
export const REPO_URL = 'https://github.com/laaa27/Ciji'

type CheckFeedback =
  | { kind: 'ok' | 'warn' | 'err'; text: string }
  | { kind: 'update'; release: ReleaseInfo }
  | null

/**
 * 设置二级页：关于。
 * 应用简介、版本信息、开源仓库地址，以及检查更新（自动开关 + 手动检查）。
 */
export default function AboutPanel() {
  const [autoCheck, setAutoCheck] = useState(true)
  const [checking, setChecking] = useState(false)
  const [feedback, setFeedback] = useState<CheckFeedback>(null)

  useEffect(() => {
    void isAutoCheckEnabled().then(setAutoCheck)
  }, [])

  async function handleToggleAuto(next: boolean) {
    setAutoCheck(next)
    await setAutoCheckEnabled(next)
  }

  async function handleCheck() {
    setChecking(true)
    setFeedback(null)
    try {
      const release = await fetchLatestRelease()
      if (!release) {
        setFeedback({ kind: 'err', text: '检查失败：连不上 GitHub（网络受限时可稍后再试）' })
        return
      }
      if (!isNewerVersion(release.version, __APP_VERSION__)) {
        setFeedback({ kind: 'ok', text: `已是最新版本（${__APP_VERSION__}）` })
        return
      }
      setFeedback({ kind: 'update', release })
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <section className={styles.section}>
        <h2 className={styles.label}>关于</h2>
        <p className={styles.about}>
          词迹记录你每天在墨墨背单词里新学、模糊、忘记的词。数据只存在这台设备上，
          不经过任何第三方服务器。
        </p>

        <div className={styles.aboutList}>
          <div className={styles.aboutRow}>
            <span className={styles.aboutKey}>版本</span>
            <span className={styles.aboutValue}>{__APP_VERSION__}</span>
          </div>
          <div className={styles.aboutRow}>
            <span className={styles.aboutKey}>数据来源</span>
            <span className={styles.aboutValue}>墨墨开放 API（公测）</span>
          </div>
          <div className={styles.aboutRow}>
            <span className={styles.aboutKey}>开源地址</span>
            <a
              className={styles.aboutLink}
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              github.com/laaa27/Ciji
            </a>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.label}>检查更新</h2>
        <p className={styles.about}>
          更新发布在 GitHub Releases 上。有新版本时，打开 App 会弹窗提示，并附上该版本的更新日志。
        </p>

        <label className={styles.switchRow}>
          <span className={styles.switchText}>
            自动检查更新
            <em>
              每次打开 App 时向 GitHub 查一次最新 release（约 3 秒后台完成，不打断使用）。
              查不到就静默跳过，不会弹任何错误。
            </em>
          </span>
          <input
            type="checkbox"
            className={styles.switch}
            checked={autoCheck}
            onChange={(e) => void handleToggleAuto(e.target.checked)}
          />
        </label>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void handleCheck()}
            disabled={checking}
          >
            {checking ? '检查中…' : '手动检查更新'}
          </button>
        </div>

        {feedback && feedback.kind !== 'update' && (
          <p className={styles.feedback} data-kind={feedback.kind}>
            {feedback.text}
          </p>
        )}

        {feedback?.kind === 'update' && (
          <div className={styles.updateCard}>
            <p className={styles.updateTitle}>有新版本：{feedback.release.version}</p>
            {feedback.release.notes && (
              <div className={styles.updateNotes}>{feedback.release.notes}</div>
            )}
            <p className={styles.help}>
              前往发布页下载：
              <a className={styles.aboutLink} href={feedback.release.url} target="_blank" rel="noreferrer">
                {feedback.release.url}
              </a>
            </p>
          </div>
        )}
      </section>
    </>
  )
}
