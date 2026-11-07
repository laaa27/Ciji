# 词迹

记录你每天在墨墨背单词里**新学、模糊、忘记**的词，攒成一本自己的词迹。

Android App，基于墨墨开放 API（公测）。数据只存在本机。

---

## 快速开始

```bash
npm install
npm run dev          # 浏览器里开发，http://localhost:5173
npm run build        # 构建 Web 产物到 dist/
npx cap sync         # 把 dist/ 同步进 Android 工程
```

浏览器里验证导入导出（需先跑 `npx vite --port 5199`）：

```bash
node scripts/test-import.mjs     # 选文件 → 预览 → 两种合并策略 → 写盘断言
```

首次使用：App 里「设置 → 接口凭证」，填入墨墨的开放 API token。
获取方式：墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API。

> 还需在墨墨 App 里打开**自动同步**，否则学习数据接口会返回空。

## 构建 APK

前置：JDK 17、Android SDK（compileSdk 36）、Gradle（用 wrapper 自动下）。

```bash
export JAVA_HOME="E:\AndroidDev\jdk-17"
export ANDROID_HOME="E:\AndroidDev\android-sdk"

npm run build
npx cap sync
cd android && ./gradlew assembleRelease
```

产物：`android/app/build/outputs/apk/release/app-release.apk`

签名配置读 `android/keystore.properties`（已被 gitignore）。换机器构建时，把 keystore 和这个文件一起带过去。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 壳 | Capacitor 8 | 把 Web 应用包成 APK，提供原生 HTTP / 文件 / 分享能力 |
| 构建 | Vite 7 | — |
| UI | React 19 + TypeScript | — |
| 状态 | Zustand | 每个 store 一个文件，没有样板代码 |
| 样式 | 原生 CSS Modules | 无 UI 库，改样式就是改 CSS |
| 图表 | ECharts 6 | 按需引入，只打包柱状图 |
| 存储 | Capacitor Preferences | 按天存 JSON 快照，见下方说明 |
| 词典 | ECDICT 裁剪版 | 分片 JSON，按首字母懒加载 |

## 目录结构

```
src/
├── api/          请求层：只负责发请求、返回类型化数据
│   ├── types.ts    所有接口类型（唯一来源）
│   ├── client.ts   鉴权、超时、错误文案、原生/浏览器分支
│   └── study.ts    三个学习接口
├── data/         存储层：只负责读写本地
│   ├── store.ts    按天存快照（day:YYYY-MM-DD）
│   └── dict.ts     词典分片懒加载 + 缓存
├── domain/       业务层：纯逻辑，好测
│   ├── collect.ts  采集编排：拉取 → 合并 → 分类
│   ├── export.ts   CSV / Markdown / 备份 JSON 生成与分享
│   └── backup.ts   导入：备份 JSON 与 CSV 的解析、校验、合并策略
├── store/        状态层（Zustand）
│   ├── session.ts  token
│   └── today.ts    今日数据 + 采集状态
└── ui/           显示层
    ├── pages/      今日 / 历史 / 统计 / 设置
    ├── components/ WordRow / TabBar / EmptyState
    └── styles/     tokens.css（设计令牌）+ global.css
```

依赖方向是单向的：`ui → store → domain → data → api`。

## 加功能要改哪里

| 想加的功能 | 改哪里 |
|---|---|
| 生词本（汇总所有忘记过的词） | `data/store.ts` 加一个聚合函数 → 新建 `ui/pages/Notebook.tsx` → `TabBar` 注册入口 |
| 分享打卡图 | 新建 `ui/pages/ShareCard.tsx` → 引 html2canvas → 设置页加入口。数据层不动 |
| 换翻译源 | 只改 `data/dict.ts` |
| 加一个统计维度 | 只改 `domain/collect.ts` 的分类逻辑 + `StatsPage` |
| 支持第三种导入格式 | 只改 `domain/backup.ts`（加一个 parser 分支），UI 不用动 |

## 设计说明

视觉概念是「一页活着的词典」：

- 单词用衬线体（Spectral），是页面绝对主角
- 状态用**页边墨线**标记——2px 竖线，颜色即状态（靛 / 赭 / 朱），像书页上的批注
- 不用卡片、不用阴影、不用圆角（除按钮的 2px）
- 全站只有三态色 + 墨色，克制

设计令牌集中在 `src/ui/styles/tokens.css`。当前只做了日间主题，夜间主题的结构已预留（`[data-theme='dark']` 块，注释状态）。

## 数据格式

每天一条，存在 `CapacitorStorage.day:YYYY-MM-DD`：

```jsonc
{
  "date": "2026-11-07",
  "finished": 32,
  "total": 150,
  "studyTimeMs": 1452000,
  "collectedAt": "2026-11-07T02:30:00.000Z",
  "words": [
    {
      "vocId": "...",
      "spelling": "abandon",
      "groups": ["new", "forget"],  // 可多归属，见下方分类口径
      "isNew": true,
      "firstResponse": "FAMILIAR",
      "lastResponse": "FAMILIAR",
      "isFinished": true,
      "order": 1
    }
  ]
}
```

**为什么不用 SQLite**：一天一条，一年 365 条，用 Preferences 足够。原生走 SharedPreferences，web 走 localStorage，两端行为一致，不需要 wasm 和平台分支。数据量真的大起来（比如五年）再换。

## 导出与导入

设置页「数据」区，三种导出、两种导入：

| 文件 | 用途 | 导回来会丢什么 |
|---|---|---|
| `词迹备份-YYYY-MM-DD.json` | **无损备份**，换手机/重装用它 | 什么都不丢 |
| `词迹-YYYY-MM-DD.csv` | 给 Excel / 别的工具看 | 学习时长、逐词首末反馈、进度总量 |
| `词迹-YYYY-MM-DD.md` | 给人读 | 同上，且不支持导入 |

导入流程：选文件 → 解析并预览（几天 / 几个词 / 哪几天本地已有）→ 选策略写入。

- **仅补空缺**：只写本地没有的日期，已有记录一律不动
- **覆盖同日期**：文件里的日期覆盖本地同一天的记录；文件里没有的日期**不会删**（导入永远不做删除）

同一天在文件里出现多次时保留词数最多的一条；同一天同一单词出现多次则合并分组。
CSV 支持带表头 / 不带表头（按导出列序）、BOM、CRLF、引号内逗号与换行。

## 分类口径（重要）

一个词可**同时属于多个分组**：`is_new` 为真即进「新学」，当天首答 `VAGUE` / `FORGET` 再进「模糊」/「忘记」。
两个维度是正交的——强行互斥会让「新学」数量凭空变少（新学但答错的词会被吞掉）。

"学过"的判据是 `is_finished === true || first_response 有值`。
不能只看 `is_finished`——学到一半退出 App 时，词已经有了反馈但还没标记完成，只看前者会漏统计。

只复习且答「认识」的词不入库（不属于任何分组）。
统计页的堆叠柱状图必须互斥才能不重复计数，所以那里改用「竖线口径」`lineState()`（按首答着色）。

## 已知限制

- **接口是公测**：字段可能变。`api/types.ts` 里除主键外都是可选，读取时降级而不是崩溃。
- **只记录打开 App 的那天**：接口没有日期参数，某天没打开，那天的反馈就取不回来了。
- **历史"模糊/忘记"是近似值**：`query_study_records` 只留 `last_response`，之后复习过就会被覆盖。历史的"新学"是精确的（`first_study_date` 固定）。
- **无 CORS 头**：浏览器直连会被拦，所以开发时走 Vite 代理，真机走 CapacitorHttp。
