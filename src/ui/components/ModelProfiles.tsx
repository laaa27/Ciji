import { useState } from 'react'

import { testConnection } from '@/api/llm'
import { PROTOCOL_LABEL, normalizeBaseUrl, type LlmProtocol } from '@/api/protocols'
import {
  PRESETS,
  newProfile,
  presetByKey,
  useLlm,
  validateProfile,
  type LlmProfile,
} from '@/store/llm'

import styles from './ModelProfiles.module.css'

/**
 * 大模型配置区：列表 + 增删改 + 切换。
 *
 * 交互取舍：
 * - 选中即切换（一键生效），不做「保存后才切换」的多余一步
 * - 新配置先测后存；测不通也给「仅保存」，免得因为模型名填错就丢了一整份配置
 * - 删除要连点两次确认，避免误删唯一的配置
 */

type Feedback = { kind: 'ok' | 'warn' | 'err'; text: string } | null

const PROTOCOL_HINT: Record<LlmProtocol, string> = {
  openai: 'https://api.deepseek.com 或 https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
}

export default function ModelProfiles() {
  const profiles = useLlm((s) => s.profiles)
  const activeId = useLlm((s) => s.activeId)
  const upsert = useLlm((s) => s.upsert)
  const remove = useLlm((s) => s.remove)
  const setActive = useLlm((s) => s.setActive)

  const [draft, setDraft] = useState<LlmProfile | null>(null)
  // 单独记「从哪个预设起的步」。不能用字段值反推 —— 一旦改协议或地址，反推就会失配，
  // 表现为刚选完预设、一换格式高亮就没了。
  const [presetKey, setPresetKey] = useState<string | null>(null)
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const isNew = draft !== null && !profiles.some((p) => p.id === draft.id)

  function openNew(key = 'zhipu') {
    setPresetKey(key)
    setDraft(newProfile(presetByKey(key)))
    setFeedback(null)
    setReveal(false)
    setPendingDelete(null)
  }

  function openEdit(profile: LlmProfile) {
    setPresetKey(null)
    setDraft({ ...profile })
    setFeedback(null)
    setReveal(false)
    setPendingDelete(null)
  }

  function patch(p: Partial<LlmProfile>) {
    setDraft((d) => (d ? { ...d, ...p } : d))
  }

  function applyPreset(key: string) {
    const preset = presetByKey(key)
    setPresetKey(key)
    setDraft((d) =>
      d
        ? {
            ...d,
            name: preset.name,
            protocol: preset.protocol,
            baseUrl: preset.baseUrl,
            model: preset.model,
          }
        : newProfile(preset),
    )
  }

  async function save(test: boolean) {
    if (!draft) return

    const problem = validateProfile(draft)
    if (problem) {
      setFeedback({ kind: 'err', text: problem })
      return
    }

    const clean: LlmProfile = {
      ...draft,
      name: draft.name.trim(),
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim(),
      baseUrl: normalizeBaseUrl(draft.baseUrl),
    }

    if (!test) {
      await upsert(clean)
      setDraft(null)
      setFeedback({ kind: 'ok', text: `已保存「${clean.name}」` })
      return
    }

    setBusy('test')
    setFeedback(null)
    try {
      const reply = await testConnection(clean)
      await upsert(clean)
      setDraft(null)
      setFeedback({ kind: 'ok', text: `连接成功，模型回复「${reply}」` })
    } catch (e) {
      setFeedback({
        kind: 'err',
        text: e instanceof Error ? e.message : '测试失败',
      })
    } finally {
      setBusy(null)
    }
  }

  async function handleSelect(id: string) {
    setPendingDelete(null)
    if (id === activeId) return
    await setActive(id)
    setFeedback(null)
  }

  async function handleDelete(id: string) {
    if (pendingDelete !== id) {
      setPendingDelete(id)
      setFeedback({ kind: 'warn', text: '再点一次确认删除（Key 也会一起删掉）' })
      return
    }
    await remove(id)
    setPendingDelete(null)
    if (draft?.id === id) setDraft(null)
    setFeedback({ kind: 'ok', text: '已删除' })
  }

  return (
    <>
      <h2 className={styles.label}>大模型</h2>
      <p className={styles.about}>
        阅读板块用它生成短文。可以存多份配置随时切换 —— 同一厂商的不同模型（chat / reasoner）
        也算两份。
      </p>

      {profiles.length === 0 && !draft && (
        <p className={styles.empty}>还没有配置。下面的预填项里挑一个开始。</p>
      )}

      {profiles.length > 0 && (
        <ul className={styles.list}>
          {profiles.map((p) => {
            const on = p.id === activeId
            return (
              <li key={p.id} className={styles.item}>
                <button
                  type="button"
                  className={styles.pick}
                  data-on={on}
                  onClick={() => void handleSelect(p.id)}
                  aria-pressed={on}
                >
                  <span className={styles.name}>{p.name}</span>
                  <span className={styles.meta}>
                    {p.model || '未填模型'} · {PROTOCOL_LABEL[p.protocol]}
                    {on ? ' · 当前' : ''}
                  </span>
                </button>
                <div className={styles.itemActions}>
                  <button type="button" className={styles.mini} onClick={() => openEdit(p)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className={styles.mini}
                    data-danger={pendingDelete === p.id}
                    onClick={() => void handleDelete(p.id)}
                  >
                    {pendingDelete === p.id ? '确认' : '删除'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {feedback && (
        <p className={styles.feedback} data-kind={feedback.kind}>
          {feedback.text}
        </p>
      )}

      {draft ? (
        <div className={styles.form}>
          <p className={styles.formTitle}>{isNew ? '添加模型' : '编辑模型'}</p>

          {isNew && (
            <div className={styles.chips}>
              {PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={styles.chip}
                  data-on={presetKey === preset.key}
                  onClick={() => applyPreset(preset.key)}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          )}

          <label className={styles.field}>
            <span className={styles.fieldLabel}>名称</span>
            <input
              className={styles.input}
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="随便起，用来在列表里区分"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>接口格式</span>
            <div className={styles.segments}>
              {(Object.keys(PROTOCOL_LABEL) as LlmProtocol[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={styles.segment}
                  data-on={draft.protocol === key}
                  onClick={() => patch({ protocol: key })}
                >
                  {PROTOCOL_LABEL[key]}
                </button>
              ))}
            </div>
          </div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Base URL</span>
            <input
              className={styles.input}
              value={draft.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
              placeholder={PROTOCOL_HINT[draft.protocol]}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
            <span className={styles.fieldHint}>
              填到版本号为止，路径自动补：{draft.protocol === 'anthropic' ? '/v1/messages' : '/chat/completions'}
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>模型名</span>
            <input
              className={styles.input}
              value={draft.model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder={draft.protocol === 'anthropic' ? '例如 claude-sonnet-4-5' : '例如 gpt-4o-mini'}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>API Key</span>
            <div className={styles.keyRow}>
              <input
                className={styles.input}
                type={reveal ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })}
                placeholder="粘贴 API Key"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className={styles.toggle} onClick={() => setReveal((v) => !v)}>
                {reveal ? '隐藏' : '显示'}
              </button>
            </div>
          </label>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void save(true)}
              disabled={busy !== null}
            >
              {busy === 'test' ? '测试中…' : '测试并保存'}
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => void save(false)}
              disabled={busy !== null}
            >
              仅保存
            </button>
            <button type="button" className={styles.ghost} onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={() => openNew('zhipu')}>
            添加模型
          </button>
        </div>
      )}
    </>
  )
}
