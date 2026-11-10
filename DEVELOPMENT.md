# 开发流程文档（DEVELOPMENT）

> 面向后续会话或新成员：照这份文档可以从零把环境搭起来、按同样的流程改代码、跑测试、出包装机。  
> 项目介绍与使用说明见 [README.md](./README.md)。

---

## 1. 环境搭建

### 1.1 必备工具

| 工具          | 版本要求             | 说明                                  |
| ----------- | ---------------- | ----------------------------------- |
| Node.js     | 22+              | 构建 / dev server / 测试脚本              |
| JDK         | 17               | Android Gradle 编译                   |
| Android SDK | compileSdk 36    | `ANDROID_HOME` 指向 SDK 目录            |
| Gradle      | 用 wrapper        | `android/gradlew` 会自动下载对应版本（8.14.x） |
| adb         | Platform-tools 里 | 真机安装与调试                             |
| Chrome      | 本机安装             | 测试脚本（puppeteer-core）指定调用本机 Chrome   |

环境变量（Windows 示例，路径按本机实际安装位置改）：

```bash
export JAVA_HOME="<JDK17 路径>"
export ANDROID_HOME="<Android SDK 路径>"
```

### 1.2 首次安装

```bash
npm install
npx cap sync android   # 首次同步，生成 Android 工程依赖
```

### 1.3 签名

Release 包签名读 `android/keystore.properties`（已被 gitignore），内容形如：

```properties
storeFile=../xxx.jks
storePassword=xxx
keyAlias=xxx
keyPassword=xxx
```

**换机器构建时，把 keystore 文件和这个属性文件一起带过去。**  
签名不一致会导致 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`——**绝对不要卸载重装来解决**（会清掉用户全部数据）。

---

## 2. 代码规范

### 2.1 架构与依赖方向

依赖是**单向**的，禁止反向引用：

```
ui → store → domain → data → api
（显示层）（状态层）（纯逻辑）（存储）（请求）
```

- `api/`：只发请求、返回类型化数据；类型唯一来源是 `api/types.ts`
- `data/`：只读写本地（Preferences / 词典分片）
- `domain/`：纯业务逻辑，不碰 DOM 和存储，方便测
- `store/`：Zustand 状态，一个 store 一个文件
- `ui/`：页面与组件，样式用 CSS Modules（无全局 UI 库）

### 2.2 TypeScript

- `tsc --noEmit` 在 `npm run build` 里强制执行，**类型错误合不进去**
- 开了 `noUnusedLocals`，临时调试变量用完要删
- 接口字段除主键外尽量可选，读取时降级而不是崩溃（墨墨 API 是公测，字段会变）

### 2.3 样式

- 每个组件配套 `.module.css`，全局设计令牌集中在 `src/ui/styles/tokens.css`
- **颜色必须走令牌**，新颜色要同时给 `:root`（浅色）和 `[data-theme='dark']`（深色）两套值；  
  深色底上用透明黑叠加会发脏的颜色（`--tint`、`--scrim`、`--switch-knob` 等）必须给独立色值
- 涉及系统栏 / 安全区的间距用 `--safe-top` / `--safe-bottom`（有 `max(env, 下限)` 兜底）

### 2.4 存储键约定

所有本地数据存在 Capacitor Preferences（原生 SharedPreferences / web localStorage），  
键名约定：

| 前缀 / 键                           | 内容             | 管理代码              |
| -------------------------------- | -------------- | ----------------- |
| `day:YYYY-MM-DD`                 | 每日学习快照         | `data/store.ts`   |
| `article:<id>` / `article_index` | 生成文章全文 / 元信息索引 | `data/article.ts` |
| `reading:YYYY-MM-DD`             | 每日阅读秒数         | `data/reading.ts` |
| `theme` / `theme_boot`           | 主题 + 启动镜像      | `store/theme.ts`  |
| `liquid_glass` / `glass_alpha`   | 玻璃底栏开关 / 透明度   | `store/glass.ts`  |
| `llm_profiles` / `llm_active`    | 大模型配置          | `store/llm.ts`    |

### 2.5 注释与语言

- 注释、提交信息、文档全部中文
- 注释写「为什么」，不写「是什么」——代码本身能看懂的不用注释

### 2.6 Git 提交

- 每完成一个完整改动就提交一次，改动前保证工作区干净
- 提交信息格式：`type: 中文摘要` + 空行 + 要点列表
  - type：`feat` / `fix` / `perf` / `refactor` / `docs` / `revert`
- 功能开发开分支（`feat/xxx`），验证通过后合回 `master`

---

## 3. 开发步骤

### 3.1 日常开发

```bash
npm run dev          # Vite dev server，默认 http://localhost:5173
```

- 测试脚本约定用 **5199 端口**：`npx vite --port 5199 --strictPort`
- 浏览器里开发时大模型 API 的 CORS 由 `vite.config.ts` 的 `__llm` 中间件转发（只存在于 dev server）
- 真机走 `CapacitorHttp`，没有 CORS 问题

### 3.2 加功能的标准动线

1. 先想清楚数据放在哪（新存储键？扩展现有快照？），按 2.4 的约定起键名
2. 纯逻辑进 `domain/`，读写进 `data/`，状态进 `store/`，最后才写 `ui/`
3. 需要原生能力时在 `android/.../` 下写 app 内插件（参考 `AppearancePlugin`），  
   `MainActivity.onCreate` 里 `super.onCreate()` **之前** `registerPlugin()`
4. 有 UI 状态跨页面的，走 Zustand store；只有组件内的用 `useState`

### 3.3 分支

```bash
git checkout -b feat/xxx     # 功能分支
# ...开发、提交...
git checkout master && git merge feat/xxx   # 验证通过后合并
```

---

## 4. 测试

### 4.1 浏览器验证脚本（puppeteer-core）

**前置：dev server 跑在 5199**（`npx vite --port 5199 --strictPort`）。

验证脚本在 `tests/e2e/`（用完即可清理，分工见 `tests/README.md`）：

| 脚本                                      | 覆盖内容                              |
| --------------------------------------- | --------------------------------- |
| `tests/e2e/test-reading.mjs`            | 阅读页 + 生成页 + 文章库 + 词卡的完整回归（66 项断言） |
| `tests/e2e/test-import.mjs`             | 导入：选文件 → 预览 → 两种合并策略 → 写盘断言       |
| `tests/e2e/test-models.mjs`             | 大模型配置：迁移 → 添加 → 切换 → 改协议 → 删除     |
| `tests/e2e/verify-readtimer.mjs`        | 阅读计时器 + 统计页阅读时长图表（10 项）          |
| `tests/e2e/verify-gencounts.mjs`        | 生成页词数口径随「包含已用词」开关同步（13 项）       |
| `tests/e2e/verify-glass.mjs`            | 液态玻璃底栏开关与样式（7 项）                 |

长期工具留在 `scripts/`：

| 脚本                        | 用途                                                          |
| ------------------------- | ----------------------------------------------------------- |
| `scripts/seed.mjs`        | 造数据：往 localStorage 预置 30 天快照 / 文章，配合截图                     |
| `scripts/shot.mjs`        | 万能截图：`node scripts/shot.mjs [url] [out.png] [tab]`          |
| `scripts/gen-article.mjs` | 生成文章并与真题语料对比；依赖同目录的 `corpus/` 与 `llm.config.json`，因此不随测试脚本迁走 |

跑法：`node tests/e2e/test-xxx.mjs`（**从仓库根目录跑**，脚本用相对路径写截图，才落在被 gitignore 的 `/*.png`），输出逐项 ✓/✗ 和总结，**退出码非 0 即有失败**。

写新验证脚本的要求：

- 断言用 `ok(name, cond, extra)` 三件套，最后打印 `结果：N 过，M 挂` 并以失败数作退出码
- 预置数据直接写 `localStorage`（键加 `CapacitorStorage.` 前缀），然后 `reload`
- 截图留档（`verify-*.png`），失败时便于回看

### 4.2 已知坑

- **dev server 状态过期**：长驻的 vite 进程跨 git 分支切换后，HMR 模块缓存可能炸出  
  `xxx is not defined`——重启 dev server 即可
- **端口被占**：`--strictPort` 下 5199 被占会直接失败，先 `netstat -ano | grep 5199` 找 PID 杀掉
- 注入点击在部分 ROM 上会被静默丢弃（见 5.3），浏览器脚本结论与真机表现冲突时以真机为准

---

## 5. 构建与部署

### 5.1 标准出包流程

```bash
npm run build                        # tsc --noEmit + vite build → dist/
npx cap sync android                 # dist/ → android 工程
cd android
./gradlew assembleRelease            # 出 release 包（用 keystore.properties 签名）
adb install -r app/build/outputs/apk/release/app-release.apk
```

产物：`android/app/build/outputs/apk/release/app-release.apk`。

### 5.2 必须知道的坑

1. **`npx cap sync` 在本工作区会被删文件钩子卡死**（报 `safe-delete` / `trash` 错误）。  
   解法：清空 NODE_OPTIONS 再跑——`NODE_OPTIONS= npx cap sync android`
2. **Gradle 找不到 JDK**：仓库的 `android/gradle.properties` 不含本机 JDK 路径（因机器而异）。  
   把下面两行写进**用户全局配置** `~/.gradle/gradle.properties`（Windows 即 `C:/Users/<你>/.gradle/`）：  
   ```properties
   org.gradle.java.home=<JDK21 路径>
   org.gradle.java.installations.paths=<JDK21 路径>,<JDK17 路径>
   ```  
   （Capacitor 8 的插件模块声明了 Java 21 toolchain，需要 21；17 也要让 Gradle 能探测到）
3. **多设备并存时 adb 命令必须带 `-s`** 指定目标（USB 序列号或 `ip:port`），否则报  
   `more than one device`
4. **签名不匹配**报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`：说明设备上装的是另一把钥匙签的包，  
   用 `assembleRelease` 出包再装；**不许卸载重装**（清数据）
5. debug 包和 release 包签名不同，不能互相覆盖安装

### 5.3 真机调试

```bash
adb devices                          # 列出设备
adb -s <目标> install -r xxx.apk     # 覆盖安装
adb -s <目标> shell am force-stop com.laaa27.maimemo
adb -s <目标> shell am start -n com.laaa27.maimemo/.MainActivity
adb -s <目标> exec-out screencap -p > shot.png    # 截图
```

- 无线调试：手机 开发者选项 → 无线调试，`adb connect <ip>:<port>`（IP 以手机上显示的为准，  
  口述常漏段；配对用 `adb pair <ip>:<pairPort>` + 配对码）
- **注入权限因 ROM 而异**：小米（HyperOS）直接拒绝 `input tap/keyevent`；  
  一加（ColorOS 16）允许但会随机丢事件。注入实验的结论不可全信，最终以真机手动验证为准
- 系统返回路径：`input keyevent 4` 在允许注入的设备上比 tap 可靠

### 5.4 出包前检查清单

- [ ] `npm run build` 通过（含类型检查）
- [ ] 相关浏览器回归脚本全过（至少 `test-reading`）
- [ ] 改过原生代码的话 `cap sync` + 完整重新 `gradlew assembleRelease`（不是只装旧包）
- [ ] 两台测试机（小米 Android 15 / 一加 Android 16）都装过并人工过一遍主流程
- [ ] 深浅两个主题都看一眼（新增颜色必须双套）
- [ ] git 已提交，提交信息符合 2.6 规范

---
