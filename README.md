# 词迹

**把每天遗忘和模糊的单词，自动写成一篇文章。**

每个目标词都会出现在正文里（漏词会被自动拦下重写），不是挨个造句再拼起来——读起来是一篇有完整结构的小短文。
篇幅与句长按四六级 / 考研真题的统计设定，仅可以作为长难句分析的阅读材料，不建议作为真题的替代品。

基于墨墨背单词开放 API 的 Android 应用，数据只存在本机。

<p align="center">
  <img src="screenshots/today.jpg?v=0237" width="16%" alt="今日" />
  <img src="screenshots/history.jpg?v=0237" width="16%" alt="历史" />
  <img src="screenshots/reading.jpg?v=0237" width="16%" alt="阅读" />
  <img src="screenshots/generate.jpg?v=0237" width="16%" alt="生成文章" />
  <img src="screenshots/stats.jpg?v=0237" width="16%" alt="统计" />
  <img src="screenshots/settings.jpg?v=0237" width="16%" alt="设置" />
</p>

---

## 核心功能

- **生成文章**：自动选取当天忘记 / 模糊 / 新学的词（含数量与类型筛选），用大模型写成一篇包含全部目标词的英语短文。
  一次并行写四稿，按「审计硬伤 + 与真题的句长/难度距离」挑最像真题的一篇，通常几秒出稿
- **点词加深**：文章里的目标词带虚线标记，点词即查释义，并显示该词在墨墨的学习状态；计划外的词可一键加入学习计划
- **文章库**：每篇生成过都自动留档，按日期回看、删除，随时重读

## 配套功能

- **每日采集**：自动拉取当天在墨墨的学习记录，按 新学 / 模糊 / 忘记 归档（一个词可多归属）
- **遗忘曲线**：统计页堆叠柱状图（近 30 天），反复忘记的词单独列出
- **阅读计时**：自动记录每天阅读时长，统计页独立图表

## 大模型配置

生成文章需要一个可调用的大模型。三步接入，以 **DeepSeek** 为例：

1. 到 [DeepSeek 开放平台](https://platform.deepseek.com/) 注册并创建 API Key（需充值，价格便宜，生成质量好）
2. App 内 **设置 → 大模型 → 添加配置**，预填项选「DeepSeek」，只需粘贴 API Key（名称、地址、模型名已自动填好）
3. 保存并选中这份配置，回阅读页点「生成」即可

> 也可以使用**智谱免费模型**（`glm-4-flash`，[智谱开放平台](https://open.bigmodel.cn/) 注册即有免费额度，
> 预填项选「智谱」），不花钱就能跑通全流程——但生成质量可能不理想。

不止 DeepSeek 和智谱：**任何 OpenAI 兼容网关**都能用（one-api、LM Studio、Ollama……）。
不是「选一个服务商」，而是**存多份配置随时切换**：

- 每份配置 = 名称 + Base URL + 模型名 + API Key
- 同一厂商的不同模型（`deepseek-chat` / `deepseek-reasoner`）算两份，切换一次点击
- 接口格式只有一种：`{base}/chat/completions`（base 无版本段时自动补 `/v1`），鉴权走 `Authorization: Bearer`

配置存在 `llm_profiles`（一整份 JSON）与 `llm_active`（当前 id）。
v0.5.0 之前的 `llm_key` / `llm_provider` / `llm_model` 会在首次启动时自动迁成一条配置，随后删除旧键。

> 浏览器里开发时，第三方 API 的 CORS 由 `vite.config.ts` 的 `__llm` 中间件转发（只跑 dev server）；
> 真机走 `CapacitorHttp`，不受 CORS 限制。

**失败处理。** 空响应（HTTP 200 但 `content` 为空）会自动重试一次：间隔 600ms；
若是「预算被用光」（`finish_reason: length` 且正文为空），逐级放大 `max_tokens` 再试（上限 32000）。
429 / 5xx 同样重试一次，鉴权与地址类错误不重试。生成失败时阅读页会给出「查看模型原始响应」。

生成默认**关闭思考**：需要的是速度（一篇几秒），而推理模型默认开着思考会把 50~90 秒和大量 token 花在思路上。

## 墨墨 API 配置

首次使用：App 里「设置 → 接口凭证」，填入墨墨的开放 API token。
获取方式：墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API。

> 还需在墨墨 App 里打开**自动同步**，否则学习数据接口会返回空。

## 快速开始（开发）

```bash
npm install
npm run dev          # 浏览器里开发，http://localhost:5173
npm run build        # 构建 Web 产物到 dist/
npx cap sync         # 把 dist/ 同步进 Android 工程
```

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

## 目录结构

```
src/
├── api/          请求层：发请求、解信封、把失败翻译成人话
├── data/         存储层：只读写本地（Preferences / 词典分片）
├── domain/       业务层：采集、生成、查词、备份、更新等纯逻辑
├── store/        状态层（Zustand）：session / today / llm / prefs / theme / glass / ui / backstack / toast
├── lib/          零依赖工具：date / text / scroll / async
└── ui/
    ├── pages/      今日 / 历史 / 阅读 / 统计 / 设置
    ├── components/ TabBar / WordSheet / ArticleLibrary / GenerateArticle / ModelProfiles / settings
    ├── hooks/      useSubView / useReadingClock / useGlossToggle / useScrollStuck
    └── styles/     tokens.css（设计令牌）+ global.css
scripts/          长期工具：生成文章与真题对比 / 造数据 / 截图
android/          Capacitor Android 工程（含 AppearancePlugin 自研原生插件）
```

依赖方向是单向的：`ui → store → domain → data → api`，`lib/` 在底层、任何层可用。


## 交互细节

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

## 声明

- 本项目为**非官方的第三方客户端**，与墨墨科技（MaiMemo）无任何隶属或合作关系
- 仅通过[墨墨开放 API](https://open.maimemo.com/)（公测）以用户本人授权的 token 访问**用户自己的**学习数据，
  遵守官方接口频控；不涉及逆向、爬虫或任何绕过官方限制的行为
- 使用本 App 即表示你已了解并同意遵守墨墨开放平台的相关服务协议；
  若墨墨调整开放策略导致接口不可用，属上游服务变更，与本项目无关
- 学习数据与生成的文章均保存在用户本机，本项目不收集、不上传任何用户数据

## 已知限制

- **接口是公测**：字段可能变。`api/types.ts` 里除主键外都是可选，读取时降级而不是崩溃。
- **只记录打开 App 的那天**：接口没有日期参数，某天没打开，那天的反馈就取不回来了。
- **历史"模糊/忘记"是近似值**：`query_study_records` 只留 `last_response`，之后复习过就会被覆盖。历史的"新学"是精确的（`first_study_date` 固定）。
- **无 CORS 头**：浏览器直连会被拦，所以开发时走 Vite 代理，真机走 CapacitorHttp。
- **备份与导出仍在调整**：导出的文件可能缺字段、导入可能失败，暂不保证可用，别当作唯一的数据保障。

## 许可

本项目代码与文档以 [CC BY-NC-SA 4.0](./LICENSE)（署名—非商业性使用—相同方式共享）提供：

- ✅ 个人学习、公益与非商业用途自由使用、修改、分发
- ❌ 不得用于商业目的
- ✳️ 修改后的衍生版本必须以相同协议（CC BY-NC-SA 4.0）开源共享

词典数据来自 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT License）。
