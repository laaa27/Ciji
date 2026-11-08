# 词迹

**把每天遗忘和模糊的单词，自动写成一篇文章。**

在阅读中重新遇见它们，巩固单词记忆；文章按考研/四六级难度生成，长难句密集，也可以直接当作阅读理解与长难句分析的练习材料。

基于墨墨背单词开放 API 的 Android 应用，数据只存在本机。

---

## 核心功能

- **生成文章**：自动选取当天忘记 / 模糊 / 新学的词（含数量与类型筛选），用大模型写成一篇包含全部目标词的英语短文
- **点词加深**：文章里的目标词带虚线标记，点词即查释义，并显示该词在墨墨的学习状态；计划外的词可一键加入学习计划
- **文章库**：每篇生成过都自动留档，按日期回看、删除，随时重读

## 配套功能

- **每日采集**：自动拉取当天在墨墨的学习记录，按 新学 / 模糊 / 忘记 归档（一个词可多归属）
- **遗忘曲线**：统计页堆叠柱状图（近 30 天），反复忘记的词单独列出
- **阅读计时**：自动记录每天阅读时长，统计页独立图表
- **液态玻璃底栏（实验性）**：悬浮半透明胶囊底栏，不透明度可调，可关闭
- **导出 / 导入**：JSON 无损备份（换机用）、CSV / Markdown 给人看

## 快速开始

```bash
npm install
npm run dev          # 浏览器里开发，http://localhost:5173
npm run build        # 构建 Web 产物到 dist/
npx cap sync         # 把 dist/ 同步进 Android 工程
```

浏览器里验证导入导出（需先跑 `npx vite --port 5199`）：

```bash
node scripts/test-import.mjs     # 导入：选文件 → 预览 → 两种合并策略 → 写盘断言
node scripts/test-models.mjs     # 模型：迁移 → 添加 → 切换 → 改协议 → 删除（需 dev server）
```

首次使用：App 里「设置 → 接口凭证」，填入墨墨的开放 API token。
获取方式：墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API。

> 还需在墨墨 App 里打开**自动同步**，否则学习数据接口会返回空。

> 环境搭建、代码规范、测试与构建、出包部署的完整流程见
> **[DEVELOPMENT.md](./DEVELOPMENT.md)**。

## 构建 APK

前置：JDK 17、Android SDK（compileSdk 36）、Gradle（用 wrapper 自动下）。

```bash
export JAVA_HOME="<JDK17 路径>"
export ANDROID_HOME="<Android SDK 路径>"

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
| 构建 | Vite | — |
| UI | React 19 + TypeScript | — |
| 状态 | Zustand | 每个 store 一个文件，没有样板代码 |
| 样式 | 原生 CSS Modules | 无 UI 库，改样式就是改 CSS |
| 图表 | ECharts 6 | 按需引入，只打包柱状图 |
| 存储 | Capacitor Preferences | 按天存 JSON 快照，见下方说明 |
| 词典 | ECDICT 裁剪版 | 分片 JSON，按首字母懒加载。数据来自 [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)（MIT） |
| 测试 | puppeteer-core | 无头 Chrome 跑断言脚本 |

## 目录结构

```
src/
├── api/          请求层：只负责发请求、返回类型化数据
│   ├── types.ts    所有接口类型（唯一来源）
│   ├── client.ts   鉴权、超时、错误文案、原生/浏览器分支
│   ├── study.ts    三个学习接口
│   ├── protocols.ts 大模型两种协议的请求构造与响应解析（纯函数）
│   └── llm.ts      大模型调用：取配置 → 选通道 → 翻译错误
├── data/         存储层：只负责读写本地
│   ├── store.ts    按天存快照（day:YYYY-MM-DD）
│   ├── article.ts  文章全文 + 索引（article:<id> / article_index）
│   ├── reading.ts  每日阅读秒数（reading:YYYY-MM-DD）
│   └── dict.ts     词典分片懒加载 + 缓存
├── domain/       业务层：纯逻辑，好测
│   ├── collect.ts  采集编排：拉取 → 合并 → 分类
│   ├── article.ts  文章生成编排 + 选词逻辑
│   ├── export.ts   CSV / Markdown / 备份 JSON 生成与分享
│   └── backup.ts   导入：备份 JSON 与 CSV 的解析、校验、合并策略
├── native/       app 内原生插件的 TS 类型声明
├── store/        状态层（Zustand）
│   ├── session.ts  token
│   ├── llm.ts      多份模型配置（增删改 + 当前选中 + 旧数据迁移）
│   ├── today.ts    今日数据 + 采集状态
│   ├── theme.ts    主题（深浅）
│   ├── glass.ts    液态玻璃底栏开关 + 不透明度
│   └── backstack.ts 安卓返回键拦截栈
└── ui/           显示层
    ├── pages/      今日 / 历史 / 阅读 / 统计 / 设置
    ├── components/ TabBar / WordSheet / ArticleLibrary / GenerateArticle / ModelProfiles
    └── styles/     tokens.css（设计令牌）+ global.css
scripts/           浏览器验证脚本（puppeteer-core），见 DEVELOPMENT.md 第 4 节
android/           Capacitor Android 工程（含 AppearancePlugin 等自研原生插件）
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

设计令牌集中在 `src/ui/styles/tokens.css`，两套主题各一份色值：

- `:root` 白天：纸 `#f7f8f5`、墨 `#16181a`，三支笔 靛/赭/朱
- `[data-theme='dark']` 深夜：纸 `#121413` 墨黑、墨 `#eceee9`，三支笔换成浅色调（不是反色）

有几类颜色**必须**给两套值，不能靠透明度叠：`--tint`（按压反馈）、`--tint-warn` / `--tint-danger`（提示条）、
`--scrim`（遮罩）、`--switch-knob`（开关滑块）。深色底上用 `rgb(0 0 0 / 6%)` 会脏，滑块颜色不对会直接看不见。

主题在设置 → 外观切换，存在 `theme`（Preferences），并往 `localStorage` 写一份 `theme_boot` 同步镜像，
启动瞬间就上色，避免深色用户先闪一帧浅色。

系统栏（状态栏 + 底部导航栏）由自研的 `AppearancePlugin`（`android/.../AppearancePlugin.java`）统一上色与切图标明暗：

- 为什么不用 `@capacitor/status-bar`：它管不到底部导航栏，而且只改图标明暗不改底色 ——
  Android 15+ 系统栏透明覆盖，看起来没问题；**Android 15 以下系统栏不透明、取主题里的浅色**，
  于是深色主题会出现「白底 + 浅色图标」的空白带，上下各一条
- `MainActivity.onCreate` 里会在首帧前读一次 `CapacitorStorage` 的 `theme`，先把系统栏上好色，
  避免冷启动先露一眼白

> 统计图表（ECharts）的颜色是 init 时从 CSS 变量读的一次性快照，主题变化时依赖变化会重建图表；
> 以后再加图表记得把 `theme` 放进 effect 依赖。

## 交互细节

**分组标题吸顶。** 今日页的「新学 / 模糊 / 忘记」用 `position: sticky` 粘在状态栏下方：

- 吸附范围被限制在各自的 `.group` 内，所以下一个标题上来时会自然把上一个顶走，不需要额外逻辑
- 只有真正贴住时才画那条分隔细线（`data-stuck`），否则每个标题下面都会多一道横杠
- `App.module.css` 的 `.body::before` 是一块 30px 的粘性遮罩：页面整体下移了 `--safe-top`，
  但滚动时内容会从状态栏底下穿过去，吸顶标题又正好停在那个位置，这条缝得盖住

**栏目状态保留。** `App` 里每个栏目是一个 `.slot` 容器，第一次进入时才挂载，之后一直留着（没轮到的
`display: none`）。所以切走再回来，阅读进度、译文开关、正在跑的生成请求都还在。
不一次性全挂载，是为了别让统计页的图表在 0 尺寸容器里初始化。

滚动位置按栏目分别记：所有页面共用一个滚动容器（`.body`），不记就会串。切换时
「保存旧的 → 恢复新的」，恢复放在 DOM 切换之后（容器高度刚变过，浏览器已经把 `scrollTop` 夹过一遍）。

**阅读页中栏吸顶。** 标题行（阅读 + 译文/字号/生成/文章库）和字号档位条都是 sticky；
生成在后台跑完而用户已经切走时，用 `store/toast.ts` 弹一条提示。

**返回键分层。** `store/backstack.ts` 是一个拦截栈：页面有子视图（文章库、生成页、词卡）时，
安卓返回键先退这一层；退无可退时连按两次**回到桌面**（`App.minimizeApp()` → `moveTaskToBack`），
进程保留在后台，下次点图标原样回来，不是杀进程。用栈而不是单个回调，是因为子视图可以叠加。

**点词查墨墨。** 词卡里除释义外还会显示该词的墨墨学习状态（加入天数、背过几次、上次反馈、下次复习、标签），
不在计划里的词可以两步确认后加入学习计划。

- **点词才查，不做预取**：一篇文章通常只点一两个词，全文预取是浪费
  （每篇文章 2~4 次请求 vs 每次点击 1~2 次，重复点走内存缓存为 0 次）
- 变形按 `lemmaCandidates` 还原（`Shipments` → `shipment`），词卡再列出本地词典里真实存在的同族形式，
  点一下就能切过去看
- 加入用 `advance: false`：只排进计划、按墨墨排期复习；`added_count` 分不清「额度不足」与「已在计划」，
  所以先查记录再决定

**生成页。** 选词界面是阅读页的另一个二级页：日期 → 词的类型 → 已用词开关 → 难度 → 词数上限 →
词表（将使用 / 不使用）→ 生成。参数在上、词表在下，先定条件再核对词。
类型框的数量口径跟随「包含已用词」开关：关着且存在已用词时显示「未用/总数」（如 `13/85`），
打开后显示全量数；已用过的词默认折叠，打开开关后手动勾选再练。

**文章库。** 入口在阅读页标题行，点开是阅读页内的一个子视图（不是新 Tab）：
按日期分组、时间倒序，可打开可删除（删除要点两次）。删除当前正在读的那篇时，
自动换成剩下最新的一篇；返回阅读页会回到进入前的滚动位置。

**阅读计时。** 停留在阅读页且打开着文章时自动计时（文章库/生成页/词卡不算），
切后台不计入。计时数字常驻顶栏（不走按钮逻辑），攒 15 秒批量落盘一次，
切后台/切栏目的瞬间也会强制落盘。数据按天存 `reading:YYYY-MM-DD`（秒），
统计页有独立的「阅读时长」柱状图（近 30 天，按分钟）。

**液态玻璃底栏（实验性）。** 设置 → 外观打开后，底栏变成悬浮的半透明胶囊：
`backdrop-filter: blur + saturate` 透出滚过的内容，颜色走 `--glass-*` 令牌随深浅主题。
不透明度在设置里滑杆调节（0~100%），实际是覆盖 CSS 变量 `--glass-alpha`。
玻璃开启时内容区自动留出底部占位。激活项有磨砂玻璃气泡替代下划线。
只动 blur/saturate 两项合成器操作，投影等装饰在手势开始时一次画好——别逐帧改。

**主题切换。** 优先用 View Transitions（Chromium 111+）：浏览器把新旧两帧各拍一张快照做 alpha 混合，
是真正的交叉淡出，而且只走合成层不重排；旧内核退回给 `html.theme-fade` 临时加颜色过渡。
系统栏没有过渡，等页面淡到 130ms 再翻色，两边看起来是一起变的。

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

## 大模型配置

设置 → 大模型。不是「选一个服务商」，而是**存多份配置随时切换**：

- 每份配置 = 名称 + 接口格式 + Base URL + 模型名 + API Key
- 同一厂商的不同模型（`deepseek-chat` / `deepseek-reasoner`）算两份，切换一次点击
- 添加时可从预填项起步：智谱 / DeepSeek / OpenAI / Anthropic / 自定义（任何 OpenAI 兼容网关）

两种接口格式：

| 格式 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| OpenAI 兼容 | `{base}/chat/completions`，base 无版本段时自动补 `/v1` | `Authorization: Bearer` | 智谱、DeepSeek、one-api、LM Studio、Ollama 都是这套 |
| Anthropic | `{base}/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` | system 提示会提到顶层字段，`max_tokens` 必填 |

配置存在 `llm_profiles`（一整份 JSON）与 `llm_active`（当前 id）。
v0.5.0 之前的 `llm_key` / `llm_provider` / `llm_model` 会在首次启动时自动迁成一条配置，随后删除旧键。

> 浏览器里开发时，第三方 API 的 CORS 由 `vite.config.ts` 的 `__llm` 中间件转发（只跑 dev server）；
> 真机走 `CapacitorHttp`，不受 CORS 限制。

**失败处理。** 空响应（HTTP 200 但 `content` 为空）会自动重试一次：间隔 600ms；
若是「预算被思维链吃光」（`finish_reason: length` 且正文为空），第二次把 `max_tokens` 翻倍（上限 8000）。
429 / 5xx 同样重试一次，鉴权与地址类错误不重试。生成失败时阅读页会给出「查看模型原始响应」。

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

## 许可

本项目代码与文档以 [CC BY-NC-SA 4.0](./LICENSE)（署名—非商业性使用—相同方式共享）提供：

- ✅ 个人学习、公益与非商业用途自由使用、修改、分发
- ❌ 不得用于商业目的
- ✳️ 修改后的衍生版本必须以相同协议（CC BY-NC-SA 4.0）开源共享

词典数据来自 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT License）。
