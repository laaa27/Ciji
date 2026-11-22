import { useEffect, useState } from 'react'

import type { GenProgress } from '@/domain/article'

import styles from '../GenerateArticle.module.css'

/**
 * 生成进度：三步走的阶段灯 + 已经等了多少秒。
 *
 * 从生成页搬出来的纯展示块。它唯一的内部状态是秒表，而秒表只在 `busy` 期间
 * 有意义 —— 所以由父层「忙时才挂载」，挂载即开始计时，不用把 busy 再传一层。
 */

/**
 * 三步进度：只表示"走到哪一步"，不画百分比。
 * 每一步的真实耗时随思考量波动（20~90 秒都见过），画进度条只会骗人。
 */
const STEPS: { key: 'outline' | 'draft' | 'save'; label: string }[] = [
  { key: 'outline', label: '列提纲' },
  { key: 'draft', label: '写正文' },
  { key: 'save', label: '存文章' },
]

/** 阶段 → 一句人话 */
function stageLine(stage: GenProgress | null): string {
  if (!stage) return '正在连接模型…'
  switch (stage.stage) {
    case 'outline':
      return '在读这些词，先想清楚这篇要论证什么'
    case 'draft':
      // 并行时把「几路里好了几路」说清楚，比转圈更能解释为什么这次值得等
      return stage.total && stage.total > 1
        ? `并行写 ${stage.total} 稿（${stage.done ?? 0}/${stage.total}），写完挑最像真题的那一篇`
        : '按提纲写正文，逐句把目标词放进论证里'
    case 'revise':
      return '挑出来的那篇还差一点（篇幅 / 缺词 / 句式），正在按问题清单改'
    case 'save':
      return '写完了，正在存进文章库'
  }
}

export default function GenProgressPanel({ stage }: { stage: GenProgress | null }) {
  /** 秒表：只让用户知道"还在动"，不做预估 */
  const [waited, setWaited] = useState(0)
  useEffect(() => {
    const t0 = Date.now()
    const id = window.setInterval(() => setWaited(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [])

  const activeStep = stage?.stage === 'save' ? 2 : stage?.stage === 'outline' ? 0 : 1
  const revising = stage?.stage === 'revise'

  return (
    <div className={styles.progress} role="status" aria-live="polite">
      <div className={styles.steps}>
        {STEPS.map((s, i) => (
          <span
            key={s.key}
            className={styles.step}
            data-on={i === activeStep}
            data-done={i < activeStep}
          >
            <span className={styles.dot} aria-hidden="true" />
            {revising && i === 1 ? '重写正文' : s.label}
          </span>
        ))}
      </div>
      <p className={styles.progressLine}>
        {stageLine(stage)}
        <span className={styles.waited}> · 已等 {waited} 秒</span>
      </p>
    </div>
  )
}
