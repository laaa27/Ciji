# 词迹 开发手册

> 基线：v0.23.0 · 分支 `refactor/extension-points`
> 面向：后续会话、新协作者、三个月后的自己。
> 目标：照这份文档能从零把环境搭起来、按同样流程改代码、跑测试、出包装机。
> 产品介绍与使用说明见 [README.md](./README.md)；验证脚本的独立说明见 [tests/README.md](./tests/README.md)。

---

## 0. 五分钟上手

```bash
cd maimemo-helper
npm install
npm run dev                    # http://localhost:5173，浏览器里就能跑
```

看效果不需要墨墨凭证，但**今日页要有数据必须配 token**（设置 → 墨墨账号），
**生成文章必须配大模型**（设置 → 大模型）。两个都是本地存储，配一次就行。

改完代码 → 提交 → 要出包时跳到第 7 章。

---

## 1. 环境搭建

### 1.1 必备工具

| 工具 | 版本 | 用途 | 备注 |
| --- | --- | --- | --- |
| Node.js | **22+** | 构建、dev server、测试脚本 | 用 `node --experimental-strip-types` 跑 `gen-article.mjs` 需要 22 |
| JDK | **17**（Gradle 守护）+ **21**（toolchain） | Android 编译 | Capacitor 8 的插件模块声明了 Java 21 toolchain，两个都要让 Gradle 找得到 |
| Android SDK | compileSdk **36** | 编译 APK | `ANDROID_HOME` 指向 SDK 根目录 |
| Gradle | 用 wrapper | 不手动装 | `android/gradlew` 自动下载 8.14.x |
| adb | Platform-tools | 真机装包与截图 | |
| Chrome | 本机安装 | 测试脚本 | `puppeteer-core` 不下载浏览器，直接调本机 Chrome |

### 1.2 环境变量（Windows 示例，路径按本机改）

```bash
export JAVA_HOME="<JDK17 路径>"
export ANDROID_HOME="<Android SDK 路径>"
```

**Gradle 找 JDK 靠用户全局配置**，仓库里的 `android/gradle.properties` 刻意不含机器相关路径：

```properties
# 写入 ~/.gradle/gradle.properties（Windows: C:/Users/<你>/.gradle/）
org.gradle.java.home=<JDK21 路径>
org.gradle.java.installations.paths=<JDK21 路径>,<JDK17 路径>
```

### 1.3 首次安装

```bash
npm install
npx cap sync android        # 生成 Android 工程依赖（首次必跑）
```

若 `cap sync` 报 `safe-delete` / `trash` 相关错误，见 8.2。

### 1.4 签名准备

Release 包签名读 `android/keystore.properties`（已 gitignore），格式：

```properties
storeFile=../xxx.jks
storePassword=xxx
keyAlias=xxx
keyPassword=xxx
```

**换机器构建时，keystore 与这个属性文件必须一起带过去。**
签名不一致会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`——**绝对不要靠卸载重装解决**，那会清掉用户全部数据。

---

## 2. 项目结构与模块职责

### 2.1 顶层目录

```
maimemo-helper/
├── src/                  应用源码（76 个文件 / 约 12.6k 行，含 CSS）
├── tests/e2e/            🆕 浏览器验证脚本（13 个，用完可清）
├── scripts/              长期工具：gen-article / seed / shot / sync_assets
├── android/              Capacitor 生成的 Android 工程（原生插件在这里）
├── public/dict/          ECDICT 分片词典（a.json ~ z.json，运行时按首字母懒加载）
├── dist/                 构建产物（gitignore）
├── index.html            Vite 入口
├── vite.config.ts        构建配置 + dev 期 CORS 中间件
├── capacitor.config.ts   appId / webDir / WebView 底色
├── tsconfig.json         strict + noUnusedLocals + noUnusedParameters
└── package.json          scripts 只有 4 个：dev / build / preview / sync
```

### 2.2 分层与依赖方向

**目标方向**（自上而下，禁止上层被下层反向引用）：

```
ui  →  store  →  domain  →  data  →  api
                  ↓
                 lib（零依赖底座，任何层都可用）
```

各层职责一句话：

| 层 | 职责 | 不该做的事 |
| --- | --- | --- |
| `api/` | 发请求、返回类型化数据、把失败翻译成人话 | 不碰存储、不碰 DOM、不知道怎么展示 |
| `data/` | 只读写本地（Preferences / 词典分片） | 不放业务判断 |
| `domain/` | 业务规则（采集、生成、查词、备份、更新） | 不碰 DOM；理想情况下零依赖，可在 node 里跑 |
| `store/` | 跨页面状态（zustand），一个 store 一个文件 | 不写业务规则 |
| `ui/` | 页面、组件、hooks、样式 | 不直接读写持久化 |
| `lib/` | 纯工具：日期、分词、滚动、异步 | **不 import 任何其它层** |

**已知偏离（3 条，都是历史原因，不要新增）**：

| 位置 | 情况 | 影响 |
| --- | --- | --- |
| `domain/article.ts` → `store/llm` + `api/llm` | domain 读全局模型配置来生成 | 它不能像 `prompts.ts` 那样在 node 里直接跑 |
| `data/dict.ts` → `api/llm` + `store/llm` | 它其实是**查词服务**，含三级回退编排，不只是数据访问 | `data` 层最重的一块；想单测它要 stub 半个应用 |
| `store/ui.ts` → `ui/components/TabBar` | 只引类型 `TabKey` | 类型放错层，应下沉到 `lib`，暂无实际危害 |

另：`src/App.tsx` / `src/main.tsx` 是**组合根**，引用所有层是正常的，不算违规。

### 2.3 模块表（🆕 新增 / ✏️ 本次结构调整）

#### api 层

| 文件 | 职责 |
| --- | --- |
| `client.ts` | 墨墨接口统一请求：信封解包、错误翻译、重试（读接口 1 次，写接口不重试） |
| `protocols.ts` | OpenAI / Anthropic 两套协议的请求构造与响应解析，**零依赖纯函数** |
| `llm.ts` | 大模型调用：选通道（原生 CapacitorHttp / dev 代理）、参数协商、预算回退 |
| `study.ts` / `vocabulary.ts` | 墨墨业务接口薄封装（`post` 的调用方） |
| `types.ts` | 墨墨 API 的唯一类型来源 |
| `appearance.ts` | 原生 AppearancePlugin 的 JS 侧桥（不是 HTTP 接口，名字有歧义） |

#### data 层

| 文件 | 职责 |
| --- | --- |
| `store.ts` | 每日快照 `day:YYYY-MM-DD`，含旧数据兼容 |
| `article.ts` | 文章全文 + 元信息索引，列表页只读索引 |
| `reading.ts` | 每日阅读秒数 |
| `dict.ts` | 词典分片 + 词形还原 + 三级查词回退（本地 → AI 释义 → MyMemory） |
| `keys.ts` | 🆕 偏好类存储键的唯一出处 |

#### domain 层

| 文件 | 职责 |
| --- | --- |
| `collect.ts` | 采集今日快照：进度 + 词表 + 逐词反馈，归成三类 |
| `article.ts` | 生成流水线：提纲 → 成文 → 审计 → 重生成；候选词与词覆盖校验 |
| `prompts.ts` | **零依赖**提示词模块，含 `LEVEL_SPEC` 难度规格、`MAX_TARGET_WORDS` / `WORD_LIMITS`（✏️ 后两者从 `article.ts` 下沉至此） |
| `phrase.ts` | 点词时在上下文里找固定搭配（±5 词窗口 + 变形还原） |
| `memo.ts` | 墨墨学习状态查询、加词、提前复习 |
| `wordforms.ts` | 同族变形（原形 + 词典里真实存在的其他形式） |
| `backup.ts` | 备份 JSON / CSV 的解析、校验、合并计划（全纯函数） |
| `export.ts` | 导出 CSV / 备份文件 |
| `update.ts` | 从 GitHub Releases 检查更新 |

#### store 层

| 文件 | 职责 |
| --- | --- |
| `session.ts` | 墨墨 token；通过 `setTokenProvider` 注入给 api 层，避免反向依赖 |
| `today.ts` | 今日快照的内存副本 + 加载状态；✏️ 采集请求加了 in-flight 合并 |
| `llm.ts` | 多份模型配置、当前选中、思考模式开关 |
| `prefs.ts` | 🆕 轻量偏好统一收纳（字号 / 词数上限 / 难度 / 两个释义开关） |
| `theme.ts` | 主题；用 localStorage 镜像保证首帧不闪 |
| `glass.ts` | 液态玻璃底栏开关与不透明度 |
| `ui.ts` | UI 状态持久化：当前栏目、滚动位置、阅读位置、选词草稿（走 localStorage，同步读） |
| `backstack.ts` | 安卓返回键拦截栈 |
| `toast.ts` | 全局一条提示 |

#### ui 层

页面：

| 文件 | 职责 |
| --- | --- |
| `TodayPage.tsx` | 今日词表（三组 + 释义开关） |
| `HistoryPage.tsx` | 按日期回看，可展开单日 |
| `ReadingPage.tsx` | ✏️ 714 → 610 行：文章渲染、点词弹层、三个子视图切换（子路由/计时/滚动已拆出） |
| `StatsPage.tsx` | 学习量与阅读时长图表（echarts） |
| `SettingsPage.tsx` | ✏️ 六个栏目的二级导航（三件套已收进 `useSubView`） |

hooks：

| 文件 | 职责 |
| --- | --- |
| `useSubView.ts` | 🆕 二级视图三件套：进出状态、返回动画、安卓返回键自动注册 |
| `useReadingClock.ts` | 🆕 阅读计时：1s 走秒 + 15s 批量落盘 + 切后台不计时 |
| `useGlossToggle.ts` | 🆕 释义展开：全局总闸（持久化）+ 单词临时覆盖（不落盘） |
| `useScrollStuck.ts` | 吸顶检测（单个 / 分组） |

组件：

| 文件 | 职责 |
| --- | --- |
| `WordSheet.tsx` | 点词弹层：释义 + 墨墨状态 + 加词（两次确认）+ 变形族 |
| `WordRow.tsx` | 词表一行（竖线颜色 + 释义 + 展开） |
| `GenerateArticle.tsx` | 生成页：选日期 / 类型 / 难度 / 词数 / 逐词勾选 |
| `ArticleLibrary.tsx` | 文章库列表（删除需二次确认） |
| `ModelProfiles.tsx` | 多份模型配置的增删改切换与连通性测试 |
| `UpdateSheet.tsx` | 更新提示弹层 |
| `EmptyState.tsx` | 空态（今日页/阅读页仍有手写副本，见第 10 章） |
| `settings/*.tsx` | 设置二级面板：墨墨账号 / 查词 / 外观 / 数据 / 关于 |

工具：

| 文件 | 职责 |
| --- | --- |
| `lib/date.ts` | 日期键、月日、星期、时长差 |
| `lib/text.ts` | 🆕 英文分词与词数统计（统一口径，替代原先 4 份副本） |
| `lib/scroll.ts` | 🆕 滚动位置恢复（60ms 首试 / 120ms 重试 / <2px 算到位 / 最多 6 次） |
| `lib/async.ts` | 🆕 `sleep`（原先 3 份副本） |

### 2.4 三条核心数据流

**采集**（今日页）
```
TodayPage effect → useToday.refresh() → domain/collect.collectToday()
  → api/study（进度 + 词表 + 末次反馈）
  → classify() 三类互斥归组
  → data/store.saveDay() 落盘
```
失败策略：进度失败不阻断词表；有旧数据时保持 `ok` 只置 `refreshing`，不整页闪「读取中」。

**生成**（阅读页 → 生成页）
```
GenerateArticle 选词 → ReadingPage.handleGenerate()
  → domain/article.generateArticle()
      ① buildOutline（提纲，失败退回单步）
      ② chatCompletion（成文）
      ③ auditArticle（篇幅 / 缺词 / 长句）
      ④ 不合格重生成一次，两次都差就标注 shortfall 仍交付
  → data/article.saveArticle()
```

**查词**（点词）
```
ReadingPage.openWord → 立即开弹层（单词）
  ├─ 快路径：findPhraseAround（本地词典短语）
  └─ 慢路径：phraseCandidates → lookupKnownPhrases（墨墨）
WordSheet → lookupOneDetailed：本地词典 → 永久缓存 → AI 释义 → MyMemory
```

### 2.5 本地存储键

原生走 SharedPreferences，Web 走 localStorage。**改键名等于清空已装机用户的该项数据，不要轻易改。**

| 键 | 内容 | 管理代码 |
| --- | --- | --- |
| `day:YYYY-MM-DD` | 每日学习快照 | `data/store.ts` |
| `article:<id>` / `article_index` | 文章全文 / 元信息索引 | `data/article.ts` |
| `reading:YYYY-MM-DD` | 每日阅读秒数 | `data/reading.ts` |
| `gloss:<word>` | 永久释义缓存 | `data/dict.ts` |
| `reading_font_size` / `reading_word_limit` / `reading_level` | 阅读偏好 | 🆕 `data/keys.ts` → `store/prefs.ts` |
| `today_show_gloss` / `history_show_gloss` | 释义展开总闸 | 🆕 同上 |
| `theme` / `theme_boot` | 主题 + 启动镜像 | `store/theme.ts` |
| `liquid_glass` / `glass_alpha` | 玻璃底栏开关 / 透明度 | `store/glass.ts` |
| `llm_profiles` / `llm_active` / `llm_gloss_active` / `llm_think_gen` / `llm_think_gloss` | 模型配置与思考开关 | `store/llm.ts` |
| `maimemo_token` | 墨墨凭证 | `store/session.ts` |
| `cjt.tab` / `cjt.scroll.*` / `cjt.read.*` / `cjt.showzh` / `cjt.gen` | UI 状态（**走 localStorage，同步读**） | `store/ui.ts` |

`store/ui.ts` 用 localStorage 而不是 Preferences 的原因：栏目与滚动位置必须在**首帧之前**就知道，否则会先闪一帧「今日」再跳走。

---

## 3. 开发规范与编码约定

### 3.1 TypeScript

- `npm run build` = `tsc --noEmit && vite build`，**类型错误合不进去**
- `strict` + `noUnusedLocals` + `noUnusedParameters` 全开：临时变量用完要删
- `noUncheckedIndexedAccess` 关闭，数组下标靠人工保证
- 禁止 `any` / `as any` / `@ts-ignore`（当前代码库 0 处，保持住）
- 接口字段除主键外尽量可选，读取时降级而不是崩溃——墨墨 API 是公测，字段会变

### 3.2 分层约定

- 新代码按 2.2 的方向放，**不要新增反向依赖**
- 需要「下层拿上层的数据」时用注入，不要 import：
  - 范例：`api/client.ts` 的 `setTokenProvider()` 由 `store/session.ts` 注入
  - 反例：`api/llm.ts` 直接 `import { useLlm }`（历史遗留，别照抄）
- 纯逻辑优先放 `domain/`，并且尽量保持可脱离浏览器运行（`prompts.ts` 是标杆）

### 3.3 样式

- 每个组件配套 `.module.css`，设计令牌集中在 `src/ui/styles/tokens.css`（74 个变量）
- **颜色必须走令牌**，当前 3312 行 CSS 里只有 1 处硬编码色，保持住
- 新颜色要同时给 `:root`（浅色）和 `[data-theme='dark']`（深色）两套值
- 深色底上用透明黑叠加会发脏的颜色（`--tint` / `--scrim` / `--switch-knob`）必须给独立色值
- 系统栏 / 安全区间距用 `--safe-top` / `--safe-bottom`（带 `max(env, 下限)` 兜底）
- 同一控件形态重复 ≥3 次时考虑抽组件，但**不要在没测试覆盖时一次性重构 14 个文件**

### 3.4 状态放在哪

| 场景 | 放哪 |
| --- | --- |
| 跨页面共享、有生命周期 | `store/` 里新建一个 zustand store |
| 单值偏好（开关 / 枚举 / 数字），需要持久化 | 🆕 加进 `store/prefs.ts`：`Prefs` 类型 + `DEFAULTS` + `PARSERS` 三处，键写进 `data/keys.ts` |
| 组件内部的瞬态 | `useState` |
| 二级视图的进出 | 🆕 `useSubView` |
| 必须首帧可读的 UI 状态 | `store/ui.ts`（localStorage 同步读） |

`store/prefs.ts` 的 `KEY_MAP` 用 `satisfies Record<keyof Prefs, string>` 做了编译期校验：**漏写键会直接报错**。

### 3.5 注释与语言

- 注释、提交信息、文档全部中文
- 注释写「为什么」，不写「是什么」——代码能看懂的不用注释
- 涉及取舍的地方把**实测依据**写进去（例：`protocols.ts` 里 reasoning 档位的合格率、`glass.ts` 里 Android 15 以下系统栏的坑）
- 单文件反复追加函数时注意 JSDoc 归属，别让它悬在不相关的函数上方

### 3.6 提交信息

格式：`type: 中文摘要` + 空行 + 要点列表。type 用 `feat` / `fix` / `perf` / `refactor` / `docs` / `test` / `chore` / `revert`。

摘要一行说清「改了什么、为什么」，不要写「update code」这类废话。

---

## 4. 构建与运行

### 4.1 开发服务器

```bash
npm run dev        # http://localhost:5173
npm run preview    # 预览 dist/ 产物，默认 4173
```

`vite.config.ts` 里两个 dev-only 的东西，**不会进包**：

| 机制 | 作用 |
| --- | --- |
| `server.proxy['/open']` | 墨墨 API 没有 CORS 头，浏览器直连会被拦；真机走 CapacitorHttp 不受影响 |
| 插件 `llmProxy`（`/__llm?url=`） | 大模型 Base URL 由用户自己填，构建期不知道目标主机，只能用运行时转发 |

### 4.2 构建

```bash
npm run build      # tsc --noEmit && vite build → dist/
```

- `base: './'` —— Capacitor 从 `file://` 加载，必须相对路径
- `__APP_VERSION__` 由 `vite.config.ts` 从 `package.json` 注入，界面直接读，避免和 `build.gradle` 各写一份
- 产物 `dist/assets/index-*.js` 约 848 kB（gzip 282 kB），构建时的 chunk 体积警告是既有的，暂不处理

### 4.3 同步到 Android

```bash
npm run sync                  # = npm run build && cap sync
# 或分步：
npx cap sync android
```

改过原生代码（`android/` 下的 Java）时，`cap sync` 之后必须完整重新 `gradlew assembleRelease`，不能直接装旧包。

---

## 5. 调试与测试

### 5.1 ⚠️ 最容易踩的坑：dev server 还是 preview

验证脚本连的是 `http://localhost:5199/`，**这个端口既可以是 `vite`（dev）也可以是 `vite preview`，两者行为完全不同**：

| 启动方式 | 服务内容 | 改源码后 |
| --- | --- | --- |
| `npx vite --port 5199` | 源码 + HMR | 立即生效 |
| `npx vite preview --port 5199` | **`dist/` 里的构建产物** | **不生效，必须先 `npm run build`** |

判断当前是哪种：

```bash
curl -s http://localhost:5199/ | grep script
# 引用 ./assets/index-xxx.js  → preview
# 引用 /src/main.tsx          → dev
```

**用 preview 时不 build 就跑测试，等于在验证上一版代码。** 这个坑真实发生过：一轮 262 断言全绿，
但完全没覆盖新改动，白跑还差点误判回归。

### 5.2 验证脚本（13 个，`tests/e2e/`）

```bash
# 前置：5199 上有服务；本机装了 Chrome
node tests/e2e/test-reading.mjs         # 66 项：阅读页 + 生成页 + 文章库 + 词卡
node tests/e2e/test-models.mjs          # 49 项：模型配置增删改切换
node tests/e2e/test-resilience.mjs      # 23 项：启动重试 / 本地兜底 / 401 不重试 / 栏目持久化
node tests/e2e/test-import.mjs          # 21 项：导入预览与两种合并策略
node tests/e2e/test-sticky.mjs          # 19 项：吸顶 + 主题过渡
node tests/e2e/verify-gencounts.mjs     # 13 项：生成页词数口径
node tests/e2e/verify-readtimer.mjs     # 10 项：阅读计时 + 统计图表
node tests/e2e/verify-reading-layout.mjs# 10 项：排版（句子连排、译文 inline）
node tests/e2e/verify-kind-toggle.mjs   #  8 项：三类互斥 + 多选
node tests/e2e/verify-glass.mjs         #  7 项：液态玻璃
node tests/e2e/verify-read-restore.mjs  #  7 项：重启后回到原处
node tests/e2e/verify-article-audit.mjs #  6 项：生成后审计与重生成
node tests/e2e/verify-phrase-match.mjs  # 23 项：点词匹配固定搭配
```

合计 **262 项断言**。跑法约定：

- **从仓库根目录执行**（脚本用相对路径写截图，才会落在被 `/*.png` 忽略的位置）
- 输出逐项 ✓ / ✗，**退出码非 0 即有失败**
- 全量跑一轮约 5 分钟；改哪块就跑对应那两三个

### 5.3 写新验证脚本的约定

- 断言用 `ok(name, cond, extra)` 三件套，最后打印 `结果：N 过，M 挂` 并以失败数作退出码
- 预置数据直接写 `localStorage`（键加 `CapacitorStorage.` 前缀），然后 `reload`
- **每个用例用独立 `browser.createBrowserContext()`**：localStorage 默认同源共享，不隔离会被上一个用例的残留污染（`test-resilience` 踩过）
- 拦截 `/open/` 请求做 mock；只想验证前端时不用真 token
- 脚本用完可以清理，但建议留 `verify-kind-toggle` 与 `verify-phrase-match`——它们覆盖的是纯逻辑边界，手点碰不到

### 5.4 长期工具（`scripts/`）

| 脚本 | 用途 |
| --- | --- |
| `gen-article.mjs` | 生成文章并与真题语料对比（`--measure` / `--dry-run` / `--models` / `--runs`）。依赖同目录 `corpus/` 与 `llm.config.json`，所以不随测试脚本迁走 |
| `seed.mjs` | 造数据：往 localStorage 预置 30 天快照 / 文章，配合截图 |
| `shot.mjs` | 万能截图：`node scripts/shot.mjs [url] [out.png] [tab]` |
| `sync_assets.py` | 同步资源到 Android 工程 |

### 5.5 真机调试

```bash
adb devices                                  # 列出设备
adb -s <目标> install -r app-release.apk      # 覆盖安装
adb -s <目标> shell am force-stop com.laaa27.maimemo
adb -s <目标> shell am start -n com.laaa27.maimemo/.MainActivity
adb -s <目标> exec-out screencap -p > shot.png
```

- 无线调试：开发者选项 → 无线调试 → `adb pair <ip>:<pairPort>`（配对码）→ `adb connect <ip>:<port>`
- **注入权限因 ROM 而异**：小米 HyperOS 直接拒绝 `input tap/keyevent`；一加 ColorOS 允许但会随机丢事件。
  注入实验的结论不可全信，**以真机手动验证为准**
- 系统返回键 `input keyevent 4` 在允许注入的设备上比 tap 可靠
- WebView 调试：`chrome://inspect` 可直连真机页面

---

## 6. 协作与分支管理

### 6.1 分支

```bash
git checkout -b feat/xxx        # 功能分支
# ...开发、逐个提交...
git checkout master
git merge feat/xxx              # 验证通过后合并
```

- 分支命名：`feat/` / `fix/` / `refactor/` / `docs/`
- **默认只提交到本地，不 push**。只有明确要求「推送到 GitHub」时才 push
- 长期分支合并前，先跑一遍全量验证脚本

### 6.2 提交节奏

- **一个完整改动一次提交**，保持工作区随时干净
- 大改动拆成「一次机械搬移 + 一次行为调整」多个提交，方便单独回退
- 提交前确认：`npm run build` 通过、相关脚本全绿、`git status` 里没有临时文件和调试日志

### 6.3 代码评审自查清单

- [ ] 有没有新增反向依赖（对照 2.2）
- [ ] 有没有把持久化写进 `ui/`（应该走 `data/` 或 `store/prefs`）
- [ ] 新增偏好是否同时改了 `Prefs` / `DEFAULTS` / `PARSERS` 三处
- [ ] 新增颜色是否给了深浅两套令牌
- [ ] 有没有留下 `any` / `console.log` / 注释掉的代码
- [ ] 复杂取舍是否写了「为什么」和实测依据

---

## 7. 发布与部署

### 7.1 版本号：三处必须同步

| 位置 | 字段 | 说明 |
| --- | --- | --- |
| `package.json` | `version` | 注入 `__APP_VERSION__`，更新检查拿它和 GitHub Release 比 |
| `android/app/build.gradle` | `versionName` | 必须与 `package.json` 一致 |
| `android/app/build.gradle` | `versionCode` | **整数，每次发版必须 +1**，否则装不上 |

### 7.2 出包流程（顺序不能乱）

```bash
# ① 先改版本号（package.json + build.gradle 两处）
# ② 再构建 —— 顺序颠倒会让 dist 里留着旧版本号
npm run build
# ③ 同步进 Android 工程
npx cap sync android
# ④ 出包
cd android && ./gradlew assembleRelease
```

产物：`android/app/build/outputs/apk/release/app-release.apk`

### 7.3 逐层校验版本号（必做）

**历史事故**：0.22.0 的包在升版前构建，之后只 `cap sync` 没重跑 `build`，
导致 APK 内嵌的版本字面量停在 0.21.0，用户「已是最新仍提示更新」。

```bash
grep -o '"version": *"[^"]*"' package.json                    # ① 源
grep -o '0\.[0-9]*\.[0-9]*' dist/assets/index-*.js | head -3   # ② 构建产物
grep -o '0\.[0-9]*\.[0-9]*' android/app/src/main/assets/public/assets/index-*.js | head -3  # ③ 同步后
# ④ 装到机器后：设置页「关于」看版本号
```

四层一致才算过。

### 7.4 发布到 GitHub Releases

仓库：`laaa27/Ciji`。更新检查逻辑在 `domain/update.ts`，读 `releases/latest`，
与 `__APP_VERSION__` 逐段比较（段数不齐按 0 补），draft / prerelease 一律跳过。

发布要点：

- tag 用 `v0.23.0` 形式（`normalizeVersion` 会去掉 `v` 前缀）
- Release 正文会原样显示在更新弹层里，写成给用户看的更新日志
- 上传 `app-release.apk` 作为资产
- 发错了要**撤下资产并修正正文**，不要只改 tag——已装机用户已经拿到链接

### 7.5 出包前检查清单

- [ ] 版本号三处同步，`versionCode` 已 +1
- [ ] `npm run build` 通过（含类型检查）
- [ ] `test-reading` + 相关脚本全绿
- [ ] 改过原生代码的话，`cap sync` 后完整重新 `assembleRelease`
- [ ] 逐层校验版本号（7.3 的四层）
- [ ] 真机装过并人工走一遍主流程（今日采集 → 阅读 → 生成 → 点词 → 设置）
- [ ] 深浅两个主题都看一眼
- [ ] git 已提交

---

## 8. 常见问题排查

### 8.1 测试相关

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 测试全绿但明显没测到新代码 | 5199 是 `vite preview`，服务的是旧 `dist/` | 先 `npm run build`；用 5.1 的方法确认服务类型 |
| 脚本报 `Cannot find package 'puppeteer-core'` | 脚本被放到项目外（如 `/tmp`） | 放在仓库内运行，ESM 只从脚本位置向上找 `node_modules` |
| `test-resilience` 偶发「只发 1 次」失败 | 连续跑多用例时同一 browser 实例相互干扰（master 上同样存在，非产品 bug） | 单跑一般稳定；已知问题，未根治 |
| 截图散落各处 / 被 git 误加 | 没从仓库根目录跑 | `cd` 到仓库根再执行；`/*.png` 已 gitignore |

### 8.2 构建相关

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `npm run build` 偶发 `error during build` | `vite preview` 正占用 `dist/`，文件锁 | 重试 1~2 次；或先停 preview |
| `cap sync` 卡死报 `safe-delete` / `trash` | 本机删文件钩子拦截 | `NODE_OPTIONS= npx cap sync android` |
| dev server 报 `xxx is not defined` | 长驻 vite 进程跨分支切换后 HMR 模块缓存错乱 | 重启 dev server |
| `--strictPort` 下 5199 起不来 | 端口被占 | `netstat -ano \| grep 5199` 找 PID 杀掉 |
| Gradle 找不到 JDK / toolchain 报错 | 用户全局 gradle.properties 缺路径 | 按 1.2 写 `org.gradle.java.home` 与 `installations.paths`（21 + 17 都要） |

### 8.3 装包与真机

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 设备上装的是另一把钥匙签的包 | 用 `assembleRelease` 出包再装；**不许卸载重装**（清数据） |
| `more than one device` | 多设备并存 | `adb -s <序列号或 ip:port>` |
| 点击注入无效 / 随机丢事件 | ROM 限制（小米拒绝、一加随机丢） | 以手动验证为准；用 `input keyevent 4` 代替 tap |
| 装上去版本号没变 | `versionCode` 没 +1，或 build 在改版本号之前 | 按 7.2 的顺序重来，并按 7.3 校验 |

### 8.4 运行时

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 启动偶发「墨墨服务端暂时异常」 | 公测接口会瞬时 500（`common_internal_error`，可能带 HTTP 200 返回） | 读接口已自动重试一次；设置页可展开看原始响应 |
| 「已是最新仍提示更新」 | APK 内嵌旧版本号 | 见 7.3 |
| 首帧闪一下浅色再变深 | 主题靠 Preferences 异步读，等它回来才上色 | 已有 localStorage 镜像，若仍闪检查 `theme_boot` 键是否被清 |
| 阅读位置重启后错位 | 译文开关与位置必须一起恢复（译文开不开高度差很大） | 检查 `cjt.showzh` 与 `cjt.read.*` 是否都在 |
| 点词没有短语 | 本地词典多词条目只覆盖约三分之一 | 有墨墨 token 时会走 `lookupKnownPhrases` 兜底；都没有就退回单词 |

---

## 9. 防止再次腐化

这个项目曾经离「屎山」不远的不是代码写错，而是**同一个东西被反复重写**：设置项四件套写 5 遍、
二级页三件套抄 4 遍、分词正则 4 份、滚动恢复 2 份。功能照样能跑，但每加一个功能都要把这些税再付一次。

下面这套规则的唯一目的：**让「加功能」的成本不随版本数量线性上涨**。

### 9.1 先认一件事：腐化的成因是「重复付税」

判断标准不是「这段代码丑不丑」，而是：

> 这个成本，是不是**不管以后加什么功能，都得再付一次**？

是 → 值得一次性消掉。
否 → 属于预测未来，等那个功能真来了再说。

2026-11 的重构就是按这条尺子做的：只消除了「每次加功能必付」的五个税点，
而把「拆分 714 行的 ReadingPage」推迟了——因为拆它只在改阅读页时才受益，且边界取决于还没想好的功能。

**任何一次重构之前，先问：我是在消税，还是在猜未来？**

### 9.2 加功能前的三个动作

1. **定位税点**：这个功能会碰下面六类里的哪几类？（见 9.3）
2. **数复制次数**：我要复制的这段代码，是第几次复制？**第 3 次就必须抽**
3. **看现状离红线多远**：打开要改的文件，对照 9.4 的阈值表。已经是黄的，先在它旁边新建文件，别继续往里塞

### 9.3 六类新功能的标准落点

| 功能类型 | 正确落点 | 不该这么做 |
| --- | --- | --- |
| **加一个设置项 / 开关** | `data/keys.ts` 加键 → `store/prefs.ts` 的 `Prefs` / `DEFAULTS` / `PARSERS` 三处 → 组件里 `usePrefs(s => s.xxx)` | 在页面里写 `useState` + `useEffect` + `Preferences.set` 四件套（这是被消掉的旧模式） |
| **加一个二级页面 / 弹层** | `useSubView<T>()` 一行，返回动画与返回键自动接管 | 手写 `returning` state + `setTimeout(320)` + `pushBackHandler`（会漏，词卡那处就漏过滚动记忆） |
| **加一个危险操作** | 两次点击确认。目前需手写（`WordSheet` / `GenerateArticle` 可参照），统一组件见第 10 章 | 一次点击就执行写操作（加词会消耗用户每天稀缺的额度） |
| **加一种 LLM 能力** | 先看 `domain/prompts.ts` 能否扩参数；**保持它零 import**，这样 `gen-article.mjs` 能在 node 里跑同一份提示词 | 直接在 `domain/article.ts` 里拼提示词（那是唯一能跑对比实验的通道） |
| **加一类数据集合** | 仿 `data/article.ts` 的「全文 `article:<id>` + 索引 `article_index`」双键模式；列表只读索引 | 列表页把所有全文读出来再解析（一千篇会卡几秒） |
| **加一个跨页状态** | `store/` 下新建一个文件，一个 store 只管一件事 | 往已有 store 里塞不相关的字段（`llm.ts` 已经因为这个变得像杂物间） |

三条硬规矩：

- **持久化不许写进 `ui/`**。要存就进 `data/`（数据集合）或 `store/prefs`（单值偏好）
- **`domain/` 不碰 DOM**。要读全局配置时优先用注入（范例 `api/client.ts` 的 `setTokenProvider`），别学 `api/llm.ts` 直接 import store
- **`lib/` 不许 import 其它层**。它是所有层的地基

### 9.4 硬阈值：什么时候该停手

超过了就先停一下，看是「合理」还是「该拆」。

| 指标 | 绿 | 黄 | 红 | 当前最差 |
| --- | --- | --- | --- | --- |
| 单文件行数（逻辑文件） | ≤ 300 | 301–500 | > 500 | `backup.ts` 466、`dict.ts` 460（黄） |
| 单组件行数（含 JSX） | ≤ 300 | 301–450 | > 450 | `ReadingPage` 610（页面特例，见下） |
| 单组件 `useState` | ≤ 6 | 7–12 | ≥ 13 | **`GenerateArticle` 14、`WordSheet` 13（红）** |
| 单组件 `useEffect` | ≤ 4 | 5–6 | ≥ 7 | `ReadingPage` 4（刚从 8 降下来） |
| 单函数行数 | ≤ 40 | 41–60 | > 60 | `chatCompletion` 95（红，暂不动） |
| 单函数分支数 | ≤ 8 | 9–12 | > 12 | `lemmaCandidates` 17（查表型，豁免） |
| 同一逻辑复制份数 | 1–2 | — | **≥ 3 必须抽** | 分词正则曾 4 份、`sleep` 曾 3 份 |

两条豁免，别被数字绑架：

1. **JSX 的嵌套深度不算逻辑复杂度**。`HistoryPage::DayItem` 有 93 行，但分支只有 1 个，主要是结构，不算红灯
2. **查表型函数不受分支数限制**。`lemmaCandidates` 17 个分支全是独立的后缀规则，拆开反而更难读

配套的自我检查：

```bash
# 找出当前最胖的组件（重构前后都该跑一次）
for f in src/ui/pages/*.tsx src/ui/components/*.tsx; do
  echo "$(wc -l < "$f") 行  useState=$(grep -c useState "$f")  $(basename "$f")"
done | sort -rn | head -5
```

### 9.5 拆分与提交的纪律

- **机械搬移和行为变更分开提交**。搬移那笔的 diff 应该只有 `+/-` 行数变化，没有逻辑差异，出问题能一眼看出是搬错了还是改错了
- **大改拆成多刀，每刀能单独回退**。本次重构 5 刀 9 个提交，每刀跑一次全量
- **每刀必须全绿才往下走**。不是「差不多」就继续——一个红断言拖到第 3 刀之后，归因成本会翻十倍

### 9.6 四种过度设计，别做

1. **为还没定的功能预先抽象**。功能没想好时抽出来的接口，八成形状是错的
2. **为「以后可能换实现」加一层包装**。这个项目只有 10 个依赖、单一后端，没有换实现的场景
3. **把纯函数包装成类**。`domain/` 里全是函数，这是优点不是缺点
4. **在没有测试覆盖时一次性重构十几个文件**。CSS 的 `.primary` 有 14 份副本，但不该一次全抽——逐次改到时再抽

### 9.7 验证纪律（这次真实踩过的）

三条，都是血换来的：

1. **先确认测试测的是哪份代码**。`vite preview` 服务的是 `dist/`，改完源码不 build 就是在验证上一版（见 5.1）
2. **「全绿」不等于「覆盖了新代码」**。断言通过只能说明旧行为没坏
3. **偶发失败先做对照实验，别急着归因给自己**。把改动 stash 掉、在基线跑同样的次数，比较失败率。
   `test-resilience` 那个 flaky 就是这么定性为「既有问题」的——否则会花几个小时去修一个自己没引入的 bug

### 9.8 加完功能的自查（5 条）

- [ ] 新增偏好是否同时改了 `PREF_KEYS` / `Prefs` / `DEFAULTS` / `PARSERS` 四处（漏一处 `tsc` 会报）
- [ ] 新增二级页面是否用了 `useSubView`，没有重复注册返回键
- [ ] 有没有让哪个文件越过 9.4 的红线；越了是合理还是该拆
- [ ] 我要复制的代码，是不是第 3 次了
- [ ] 相关脚本全绿，并且确认跑的是当前源码

---

## 10. 已知遗留与后续方向

不是 bug，是「知道但还没做」的清单，避免重复调研：

| 项 | 现状 | 建议时机 |
| --- | --- | --- |
| `GenerateArticle` / `WordSheet` 的 state 密度 | 14 / 13 个 `useState`，已越过 9.4 的红线（比重构后的 `ReadingPage` 12 个还多）。前者是选词表单（日期/类型/难度/上限/草稿恢复/已用词…），后者是词卡（释义/短语视图/墨墨状态/加词确认…） | 下次改这两个文件时，按「表单状态收 reducer」「词卡数据获取抽 hook」分块搬，别一次重写 |
| `ConfirmButton` 统一二次确认 | 三处各写一遍（WordSheet / GenerateArticle / ArticleLibrary），行为还不一致 | 下次加危险操作时顺手统一 |
| `chatCompletion` 状态机化 | 95 行 / 14 分支 / 3 套重试交织，目前正确但改动易回归 | 有单测兜底后再动 |
| CSS 基础控件组件化 | `.primary` 在 14 个 module.css 里各写一遍 | 逐次改到时再抽，别一次性重构 |
| `test-resilience` 剩余 flaky | 连续跑多用例时偶发，已降到约 1/4 | 单独立项排查 |
| `data/dict.ts` 职责过重 | 同时做数据访问与查词编排，460 行 | 若要单测查词逻辑，先拆成 `data/dict` + `domain/lookup` |
| `domain/article.ts` 依赖 store | 读全局模型配置，导致它不能在 node 里直接跑 | 想用脚本做生成对比实验前，先改成依赖注入 |
| 空态卡片复用 | `EmptyState` 已存在，但今日页/阅读页仍手写 | 顺手替换 |
| 单元测试 | 无（只有 13 个 e2e 脚本） | 若引入 vitest，优先覆盖 `backup.splitCsv` / `parseImportText` / `lemmaCandidates` / `phraseVariants` / `isCovered` / `isNewerVersion` |

---

## 附：命令速查

```bash
# 开发
npm run dev                              # 5173
npx vite --port 5199 --strictPort        # 测试用 dev server
npx vite preview --port 5199             # 测试用 preview（记得先 build）

# 构建
npm run build                            # tsc --noEmit + vite build
npm run sync                             # build + cap sync

# 测试
node tests/e2e/test-reading.mjs          # 单个
for f in tests/e2e/*.mjs; do node "$f"; done   # 全量（约 5 分钟）

# 出包
cd android && ./gradlew assembleRelease
adb -s <目标> install -r app/build/outputs/apk/release/app-release.apk
```
