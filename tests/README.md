# tests/ —— 浏览器端到端验证脚本

这一层是**用完即走的验证脚本**：每次改动后跑一遍确认行为没坏，跑完就可以清理，不追求长期维护成回归套件。

## 与 scripts/ 的分工

| 目录 | 放什么 | 生命周期 |
|---|---|---|
| `scripts/` | 工具：`gen-article.mjs`（生成文章/对比真题语料）、`seed.mjs`（造数据）、`shot.mjs`（截图）、`sync_assets.py`（同步资源） | 长期，随开发反复用 |
| `tests/e2e/` | 验证脚本：`test-*.mjs`、`verify-*.mjs` | 针对某次改动的临时验证，验完可删 |

`scripts/gen-article.mjs` 依赖同目录的 `corpus/` 与 `llm.config.json`（均已 gitignore），所以它必须留在 `scripts/`，不能挪进这里。

## 跑法

**从仓库根目录运行**（脚本用相对路径写截图，从根目录跑才会落在 `/*.png` 的忽略规则里）：

```bash
# 1. 先起服务（多数脚本要 5199 端口）
npx vite --port 5199          # 或 npx vite preview --port 5199

# 2. 再跑脚本
node tests/e2e/verify-kind-toggle.mjs
node tests/e2e/verify-phrase-match.mjs
```

输出逐项 `✓` / `✗` 并给总结，**退出码非 0 即有失败**。

## 前置条件

- 脚本用 `puppeteer-core`，Chrome 路径硬编码在文件头的 `CHROME` 常量
  （`C:\Program Files\Google\Chrome\Application\chrome.exe`），换机器要改这一行。
- 部分脚本需要预置数据（localStorage 里的快照 / 文章 / 模型配置），
  由脚本内部的 `page.evaluateOnNewDocument` 注入，不依赖真实账号。
- 需要真实 API Key 的脚本在文件头注释里会写明。

## 值得常驻的两个

其余脚本验完即可删，下面两个带真断言、秒级跑完、覆盖边界情况，建议留着：

| 脚本 | 覆盖 |
|---|---|
| `verify-kind-toggle.mjs` | 生成页「三类互斥」+ 类型取消 + 多选（8 断言） |
| `verify-phrase-match.mjs` | 点词自动匹配固定搭配、变形还原（23 断言） |

理由：这两处对应 `domain/article.wordCandidates` 与 `domain/phrase.phraseVariants`，
逻辑密集且没有手点路径能覆盖边界。特别是哪天要动 `api/llm.chatCompletion`
（95 行 / 14 分支 / 3 套重试策略）或 `domain/backup.splitCsv`（CSV 状态机）时，
纯手点验证不到引号转义、截断顺序这类情况。
