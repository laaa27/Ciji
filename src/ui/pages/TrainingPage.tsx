import { useState } from 'react'

import EmptyState from '../components/EmptyState'

import styles from './TrainingPage.module.css'

/**
 * 训练页：把真题当练习材料。
 *
 * 现在只有界面：档位切换与套卷列表的形状定下来，题目数据还没有来源。
 * 数据接进来时，套卷列表按 `data` → `domain` → `ui` 的方向补，页面本身不用改结构。
 */

const LEVELS = [
  { key: 'cet4', label: '四级' },
  { key: 'cet6', label: '六级' },
  { key: 'kaoyan', label: '考研' },
] as const

type Level = (typeof LEVELS)[number]['key']

export default function TrainingPage() {
  /**
   * 档位只活在本页：还没有题目可挑，记不住上次选了哪档也不影响什么。
   * 等真要从上次的档位接着练，再按「单值偏好」落到 store/prefs。
   */
  const [level, setLevel] = useState<Level>('cet4')

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>训练</h1>
        <p className={styles.lede}>用真题练手：先自己做，再逐句读。</p>
      </header>

      <div className={styles.segments} role="tablist" aria-label="训练档位">
        {LEVELS.map((lv) => (
          <button
            key={lv.key}
            type="button"
            role="tab"
            aria-selected={level === lv.key}
            className={styles.segment}
            data-on={level === lv.key}
            onClick={() => setLevel(lv.key)}
          >
            {lv.label}
          </button>
        ))}
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>套卷</h2>
        <EmptyState
          title="题库还没接入"
          hint="真题原文、解析与逐句翻译准备好之后，这里会按年份列出套卷。"
        />
      </section>
    </div>
  )
}
