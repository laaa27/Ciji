import styles from '../../pages/SettingsPage.module.css'

/** 项目仓库地址，GitHub 上的开源主页 */
export const REPO_URL = 'https://github.com/laaa27/Ciji'

/**
 * 设置二级页：关于。
 * 应用简介、版本信息、开源仓库地址。
 */
export default function AboutPanel() {
  return (
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
  )
}
