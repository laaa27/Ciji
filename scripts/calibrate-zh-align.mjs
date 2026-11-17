#!/usr/bin/env node
/**
 * 一次性校准：把渲染层逐句对齐仍对不上的段落（切法见 domain/training.ts 的
 * ZH_SPLIT_RE，约 6%），用 LLM 把段译碎片归属到各句，写进题库的 sents[].zh。
 *
 * 为什么是归属而不是重新翻译：译文是题库内容，只允许「拼接碎片 / 在标点或词的
 * 边界处切开」，禁止改写 —— 校验时拿字符总量兜底。
 *
 * 校验与重试：
 *   - LLM 输出条数必须等于英文句数；字符总量与碎片总量偏差 ≤15%
 *   - 失败时把具体问题（条数差多少、少了多少字）回喂给模型再试，最多 4 轮
 *   - 4 轮仍失败的段：整文件不落盘（避免半成品），下次重跑自动补
 *   - 可重复跑：已带全句级 zh 的段自动跳过
 *
 * 用法：
 *   node scripts/calibrate-zh-align.mjs            # 实际校准并写回
 *   node scripts/calibrate-zh-align.mjs --dry     # 只统计要校准多少段，不调模型
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cfg = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'llm.config.json')),
)
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/training/p')
const DRY = process.argv.includes('--dry')

/* 与 domain/training.ts 保持一致的切法（改切法时两边同步） */
const JUNK_RE = /\s*Questions?\s+\d+[\s\S]*$/i
const SPLIT_RE = /(?<=[。！？!?])(?![”’"'])|(?<=[。！？!?][”’"'])/

const splitZh = (t) =>
  t
    .replace(JUNK_RE, '')
    .split(SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean)

/* ---------- 收集待校准段 ---------- */

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'index.json')
const tasks = []
const fileParas = new Map() // file -> [task]

for (const f of files) {
  const paper = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8'))
  const entries = []
  for (const sec of paper.sections ?? []) {
    if (!sec.id?.startsWith('reading')) continue
    for (const pas of sec.passages ?? []) {
      ;(pas.paras ?? []).forEach((para, paraIdx) => {
        if (!para.zh) return
        if ((para.sents ?? []).every((s) => s.zh)) return // 已校准
        const frags = splitZh(para.zh)
        if (frags.length === para.sents.length) return // 已能对齐
        entries.push({ para, secId: sec.id, pasId: pas.id, paraIdx, frags })
      })
    }
  }
  if (entries.length > 0) fileParas.set(f, entries)
  tasks.push(...entries.map((e) => ({ ...e, file: f })))
}

console.log(`待校准段落：${tasks.length}（涉及 ${fileParas.size} 个文件）`)
if (DRY || tasks.length === 0) process.exit(0)

/* ---------- LLM 调用（60s 超时） ---------- */

async function chatOnce(prompt) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content ?? ''
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''))
}

const charsOf = (arr) => arr.join('').replace(/\s/g, '').length

const PROMPT = (ens, frags, n) => `你是文本对齐助手。下面是一段英文的句子列表（编号 0..${ens.length - 1}）和它对应的中文译文碎片列表（编号 0..${frags.length - 1}）。译文碎片与英文句不是一一对应：有的英文句的译文被拆成多个碎片，有的碎片横跨两句英文。

【英文句】
${ens.map((s, i) => `${i}. ${s}`).join('\n')}

【中文碎片】
${frags.map((s, i) => `${i}. ${s}`).join('\n')}

任务：把碎片重新组织成恰好 ${n} 条中文，第 i 条对应第 i 句英文。

规则：
1. 只能把碎片原样拼接、或在标点/词的边界处切开，禁止改写、增删、翻译任何字词，禁止丢掉任何标点
2. 每条中文必须完整覆盖对应英文句的译文内容；所有碎片的内容都要用到，且只用一次
3. 严格输出 JSON：{"zh": ["第0句的中文", ...]}，数组长度必须等于 ${n}，不要输出任何其他文字`

/**
 * 校准一段。失败时把具体问题回喂给模型（重试必须回喂，原样重发等于重新抽签），
 * 最多 4 轮；全部失败返回 null。
 */
async function calibrate(task) {
  const { para, frags } = task
  const ens = para.sents.map((s) => s.en)
  const n = ens.length
  const wantChars = charsOf(frags)
  let lastProblem = ''
  for (let round = 1; round <= 4; round++) {
    let out
    try {
      const feedback = lastProblem
        ? `\n\n【上一轮被拒绝】${lastProblem}\n请重新输出，务必满足上面的规则。`
        : ''
      out = await chatOnce(PROMPT(ens, frags, n) + feedback)
    } catch (e) {
      lastProblem = `调用失败：${e.message}`
      continue
    }
    const zh = out?.zh
    if (!Array.isArray(zh) || zh.length !== n || zh.some((s) => typeof s !== 'string' || !s.trim())) {
      lastProblem = `条数错误：必须恰好 ${n} 条，你输出了 ${Array.isArray(zh) ? zh.length : '非数组'}`
      continue
    }
    const chars = charsOf(zh)
    if (Math.abs(chars - wantChars) / Math.max(wantChars, 1) > 0.15) {
      lastProblem = `字符总量错误：碎片共 ${wantChars} 字（不含空白），你只输出了 ${chars} 字 —— 你删掉了内容。所有碎片内容必须原样保留，包括标点和引号`
      continue
    }
    para.sents.forEach((s, i) => {
      s.zh = zh[i].trim()
    })
    return true
  }
  return false
}

/* 并发 8，逐文件写回（一个文件的任务全成功才落盘，避免半成品） */
let done = 0
let failed = 0
const queue = [...tasks]
const progress = (m) => process.stderr.write(`${m}\n`)

async function worker() {
  while (queue.length > 0) {
    const t = queue.shift()
    const ok = await calibrate(t)
    if (ok) done++
    else failed++
    progress(`[${done + failed}/${tasks.length}] ${ok ? 'OK' : 'FAIL'} ${t.file} 段${t.paraIdx}`)
  }
}
await Promise.all(Array.from({ length: 8 }, () => worker()))

for (const [f, entries] of fileParas) {
  const pending = entries.filter((e) => !e.para.sents.every((s) => s.zh)).length
  if (pending > 0) {
    progress(`跳过文件 ${f}（${pending} 段未成功）`)
    continue
  }
  const paperPath = path.join(DIR, f)
  const paper = JSON.parse(fs.readFileSync(paperPath, 'utf-8'))
  for (const e of entries) {
    paper.sections
      .find((s) => s.id === e.secId)
      ?.passages.find((p) => p.id === e.pasId)
      ?.paras[e.paraIdx]?.sents.forEach((s, i) => {
        s.zh = e.para.sents[i].zh
      })
  }
  fs.writeFileSync(paperPath, JSON.stringify(paper), 'utf-8')
}

console.log(`本轮校准成功 ${done} 段，失败 ${failed} 段（失败的文件未落盘，重跑自动补）`)
