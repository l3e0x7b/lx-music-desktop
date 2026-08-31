# AGENTS.md

## 项目概述

LX Music（洛雪音乐助手）桌面版：一个基于 **Electron 40 + Vue 3** 的跨平台音乐软件（Windows 7+ / macOS / Linux）。负责从用户自定义的"音乐源"（User API）获取搜索结果与歌曲链接，实现在线搜索、歌单、排行榜、本地音乐库管理、歌词显示（含桌面歌词）、下载、多设备数据同步、开放 API 等服务。

- 语言：TypeScript + JavaScript（Vue 3 组件，部分使用 Pug 模板 + Less 样式）
- 存储：`better-sqlite3`（SQLite，位于 main 进程 worker 线程）；JSON 配置文件（`store.ts`）
- 无 Pinia/Vuex，状态管理为手写的 `ref/reactive` 单例 store 模块
- 包管理器：npm（`package-lock.json`），Node >= 22
- 协议：Apache-2.0

## 仓库定位与分支约定

本仓库为上游 `lyswhut/lx-music-desktop` 的 fork（本仓库名 `l3e0x7b/lx-music-desktop`），基于原生 **v2.12.2** 改造（当前特性：mbz 作品集搜索）。以下约定**仅适用于本仓库**，与上游发布策略无关：

- **版本号固定为 2.12.2**，不随上游升级；
- **交付产物**：当前分支**仅构建 win 绿色版** `lx-music-desktop-v2.12.2-mbz-win_x64-green.7z`，其余平台/安装包/win7 等目标暂不构建（见「打包」）；
- git `origin` 与 `build-config/build-pack.js` 的 `publish` 目标均指向自有仓库（`l3e0x7b/lx-music-desktop`）；
- 与上游同步（rebase/merge）或向上游提交时，注意排除上述本地化改动。

## 顶层目录

```
build-config/       webpack 构建、打包、发布脚本（Node.js）
dist/               webpack 产物（gitignored，package.json "main": ./dist/main.js）
build/              electron-builder 产物（gitignored）
src/
  main/             Electron 主进程（应用生命周期、IPC、DB worker、同步服务、开放 API）
  renderer/         主窗口 Vue 3 渲染进程（播放器、搜索、列表、设置等 UI）
  renderer-lyric/   桌面歌词独立 Vue 应用（对应独立窗口）
  common/           主/渲染/歌词进程共享代码（IPC 名称与封装、常量、默认设置、类型、主题）
  lang/             i18n 词典与自定义 i18n 引擎
  static/           静态资源（任务栏/托盘图片等）
build-config/
  lib/              本地提交的原生模块二进制（qrc_decode / better_sqlite3，勿自行重建）
publish/            版本管理与发布脚本（npm run publish）
resources/          打包资源（图标、license 等）
doc/                文档图片等资源
PLAN.md             本 fork 的 mbz 作品集搜索功能开发计划（对应 opencode/feat 分支）
```

## 核心架构要点

### Electron 进程与窗口

- **入口**：生产 `src/main/index.ts` → `dist/main.js`；开发 `src/main/index-dev.ts`（devtools + Vue devtools）。
- **启动流程**（`src/main/index.ts`、`src/main/app.ts`）：`initGlobalData()` → 单实例锁 → 环境参数 → data path（支持 portable 模式）→ deeplink `lxmusic://` → `app.whenReady` 后 `initAppSetting()`（初始化 DB worker、设置、主题、旧数据迁移）→ `registerModules()`（`src/main/modules/index.ts`，注册顺序：`userApi → commonRenderers → winMain → hotKey → tray → appMenu → winLyric`）→ 发射 `app_inited`。
- **全局对象**：`global.lx`（`event_app`/`event_list`/`event_dislike` 事件总线、`appSetting`、`worker.dbService`、`hotKey`、`theme`、`player_status`）；另设 `global.lxDataPath`（如 `%APPDATA%/lx-music-desktop/LxDatas`）。渲染进程暴露 `window.lx`、`window.app_event`、`window.key_event`。
- **窗口**：
  - 主窗口（无边框、禁用缩放），加载 `src/renderer`（dev: `localhost:9080`）。
  - 桌面歌词窗口（透明、置顶、跳过任务栏），独立 Vue 应用 `src/renderer-lyric`（dev: `localhost:9081/lyric.html`）。
  - User API 窗口：隐藏的沙箱 BrowserWindow，执行用户自定义音乐源脚本（`contextBridge` preload）。

### IPC 机制

- **通道命名规范**：`src/common/ipcNames.ts` 以嵌套对象定义命名空间（`common`、`player`、`dislike`、`winMain`、`winLyric`、`hotKey`），运行时自动加前缀形如 `winMain_quit`、`player_list_get`。所有 `ipcMain.handle`/`ipcMain.on` 与 `webContents.send` 都使用该注册表，**不要硬编码通道字符串**。
- **收发封装**：
  - 主进程侧：`src/common/mainIpc.ts`（`mainOn/mainHandle/mainSend` 等，handler 接收 `{ event, params }`）。
  - 渲染进程侧：`src/common/rendererIpc.ts`（`rendererInvoke/rendererSend/rendererOn` 等）。
  - 渲染层统一 API 门面：`src/renderer/utils/ipc.ts`（855 行，封装设置/主题/歌词/下载/同步/窗口控制等 全部 IPC 调用）。
- **注册位置**（仅在模块初始化时一次性注册）：
  - 主窗口 hub：`src/main/modules/winMain/rendererEvent/index.ts`（含 common/list/dislike、app、hotKey、lyric 解码、userApi、sync、data、music、download、soundEffect、openAPI）。
  - `src/main/modules/commonRenderers/*/rendererEvent.ts`（公共/list/dislike，多窗口共享）。
  - `src/main/modules/winLyric/rendererEvent.ts`（歌词窗口）。
- **主进程 → 渲染进程推送**：各窗口模块提供 `sendEvent(name, params)`（`mainSend`）；内部事件转推由 `commonRenderers/*/winRendererEvent.ts` 订阅 `event_app/event_list/event_dislike` 后广播；配置变化通过 `winMain_on_config_change` 推送（`winMain/rendererEvent/app.ts:143-145`）。
- **进程信使**：
  - 主进程 ↔ DB worker：**Comlink** over `node:worker_threads`（`src/main/worker/utils/index.ts`）。
  - 主窗口 ↔ 歌词窗口：**MessageChannelMain** 端口移交（`winLyric/rendererEvent.ts`），之后两渲染端直连。
  - 同步服务 ↔ 外部设备：**message2call** RPC over 加密 WebSocket。
  - 主进程 ↔ User API 窗口：普通 IPC（`userApi_*` 通道，`requestKey` 关联请求/响应，20s 超时）。

### 数据库（better-sqlite3，worker 线程）

- 位置：`<lxDataPath>/lx.data.db`（WAL 模式），原生绑定在 webpack 中 external。
- 表（`src/main/worker/dbService/tables.ts`）：`db_info`、`my_list`、`my_list_music_info(+order index)`、`music_info_other_source`、`lyric`、`music_url`、`download_list`、`dislike_list`。当前 `DB_VERSION = '2'`。
- 迁移：`dbService/migrate.ts` 基于 `db_info.field_value='version'` 门控。
- 校验：`verifyDB.ts` 比对 DDL；失败时 `app.ts` 备份为 `lx.data.db.<timestamp>.bak` 并重建。
- 访问模式：`dbService/modules/*/index.ts`（服务 API + 内存缓存）、`dbHelper.ts`（prepared statements + transaction）、`statements.ts`（SQL 构造）。
- **列表数据以主进程为来源**：渲染进程只持有 `allMusicList` Map 缓存，通过 IPC 变更，并通过 `registerListAction()`（`src/renderer/store/list/listManage/rendererListManage.ts`）订阅主进程推送，保持多窗口一致。

### 音乐源（User API）

- 在线搜索/取 URL 逻辑实现为用户脚本（自定义源），在隐藏的 API 窗口中执行（`src/main/modules/userApi/`，窗口为 `sandbox: false` + `contextIsolation: true`，通过 contextBridge preload 隔离）。
- 预加载 `src/main/modules/userApi/renderer/preload.js` 通过 contextBridge 暴露 `lx.request/lx.send/lx.on`（含 http/crypto/buffer/zlib 等）给用户脚本；支持内置 API 列表、gzip 存储、JSDoc 头解析（`@name/@version`）。
- URL 获取通过 `requestKey` 队列转发，20s 超时。内置官方平台源名为 kw/kg/tx/wy/mg/bd（酷我/酷狗/腾讯/网易/咪咕/百度…均为 User API 脚本）。

### 同步服务（src/main/modules/sync/）

- 服务器 + 客户端双角色，支持局域网/公网多设备同步。HTTP 鉴权（6 位码，~3 分钟轮换）+ AES/RSA；WebSocket + message2call；payload > 1024 字符自动 gzip。默认端口 **23332**（`defaultSetting.ts` 的 `sync.server.port`；`server.ts` 中的 9527 仅为未传参时的兜底，实际不生效）。
- 特性：`list` 与 `dislike`，各版本 1；list 同步支持 6 种合并/覆盖模式（含基于快照的三方合并）。
- 数据文件（运行时生成于同步数据目录，不提交仓库）：`sync/server/devices.json`（设备信息）、`sync/client/syncAuthKey.json`（客户端密钥）；快照文件 `sync/server/list/snapshot/`。
- 状态推送主窗口（`winMain/rendererEvent/sync.ts` 的 `sendServerStatus/sendClientStatus`）。

### 开放 API（src/main/modules/openApi/）

本地 HTTP 服务：`GET /status`、`/lyric`、`/lyric-all`、`/subscribe-player-status`（SSE 流）、控制 `/play /pause /skip-next /pause /skip-prev /seek /collect /uncollect /volume /mute`。控制通过合成任务栏按钮点击事件发送到渲染进程。

### 主题系统

- 内置主题：`src/common/theme/index.json`（由 `src/common/theme/createThemes.js` 构建，运行 `npm run build:theme`）；CSS 变量（`--color-primary` 等 300+）由渲染进程注入 `<style>`。
- 用户主题存在 `<lxDataPath>/theme_images`；自动/明暗跟随由 `theme.id` + 系统主题决定。
- 主题应用：`src/renderer/store/utils.ts`（applyTheme/buildThemeColors），主进程 `src/main/utils/index.ts` 解析有效主题并改写背景图 URL（`getAllThemes` 自 211 行起，`getTheme` 主体约在 245-287 行）。

### 播放器（渲染进程，src/renderer/plugins/player/）

单 `HTMLAudioElement` + Web Audio 图（analyser → 10 段 biquad EQ → AudioWorklet 变调 → 卷积混响 → compressor → panner → gain）。EQ 预设/卷积"filter"来自 `assets/medias/filters/*.wav`。
- 播放逻辑在 `store/player/` + `core/useApp/usePlayer/`：URL 获取、源切换、超时/重试、会话恢复。
- 播放状态镜像到主进程驱动托盘/任务栏/开放 API/歌词窗口。
- Lyrics 引擎 `src/common/utils/lyric-font-player`（共享），渲染层 `src/renderer/core/lyric.ts` 自行计算逐字。

### i18n（src/lang/）

- 自定义引擎，**非 vue-i18n**：`src/lang/i18n.ts`（`createI18n()`、`useI18n()`、`$t`、`fillMessage` 插值 `{key}`）。
- 词典为平面 JSON key：`zh-cn.json`、`zh-tw.json`、`en-us.json`，语言元数据 `languages.json`。**新增 key 时三个语言文件必须同步**。回退链到 zh-cn。

### 多窗口/渲染子应用

- `src/renderer-lyric/`：独立 Vue 入口 （`main.ts`）、模板 `index.html`（webpack 输出为 `lyric.html`）、端口桥 `core/mainWindowChannel.ts`（MessagePort）、字体级歌词播放器。设置通过 `getSetting` IPC 获取。
- `src/renderer-loader/` 不存在；编辑区各渲染端以独立 webpack target 构建。

## 构建 / 开发

- 4 个独立 webpack target：`main`（dist/main.js）、`renderer`（dist/renderer.js）、`renderer-lyric`（dist/lyric.html）、`renderer-scripts`（dist/user-api-preload.js，User API preload）。配置在 `build-config/<target>/`，`webpack-merge` 组合 base/dev/prod。
- **开发**：`npm run dev` → `build-config/runner-dev.js` 并行启动 2 个 `webpack-dev-server`（端口 9080 / 9081）+ main 与 scripts 的 `watch`；主进程变动后自动 `tree-kill` 重启 Electron（`--inspect=5858`）。先 `replaceLib()`（`build-before-pack`）换原生模块。
- **生产**：`npm run build`（`build-config/pack.js` 并行跑 4 个 prod 编译）→ `npm install`.

> 注意：`postinstall` 为 `electron-builder install-app-deps`，会重新编译原生依赖；`build-config/lib/` 中为各平台/ABI 的预编译 `.node`（当前 Electron ABI v143，Electron 22 用 v110），由 `build-before-pack.js` 拷贝/替换，**不要改动 net 或 lib 中的二进制**。若需重新构建原生模块，参考 `build-config/lib-update.js`（解包 tar.gz 到规范命名）。

- **打包**：`build-config/build-pack.js`（electron-builder）。脚本保留上游完整目标矩阵：win（nsis/7z/portable/win7_*）、linux（deb/AppImage/pacman/rpm）、mac（dmg）；但**本分支当前仅构建 win 绿色版**，产物 `lx-music-desktop-v2.12.2-mbz-win_x64-green.7z`，其余目标暂不构建。平台差异：win 用 NSIS（语言 2052，`lxmusic` 协议），linux 自定义 `.desktop`（`x-scheme-handler/lxmusic`），mac `afterPack` 写 InfoPlist.strings 本地化（electron-builder 问题 #4630 workaround）。产物命名由 `artifactName` 决定；本仓库的版本固定与 `mbz` 命名标识约定见「仓库定位与分支约定」。
- **发布**：GitHub Actions。
  - `release.yml`（master 触发）→ 4 任务（win / win7 / mac / linux）`publish:*` 上传 GitHub Releases。
  - `beta-pack.yml`（beta 触发）→ `pack:*` + upload artifact。
  - `build-test.yml`（PR→dev）：lint → build。
  - `publish-version-info.yml`（release published → repository_dispatch 到 `lyswhut/lx-music-desktop-version-info`）；共享 setup action：`.github/actions/setup`。
  - Windows 7 特殊：Electron 22、`undici@5`、`BUILD_WIN7` env；renderer 的 prod 构建（`build-config/renderer/webpack.config.prod.js`）在 CI 中要求工作区干净（除非 `BUILD_WIN7`）。

## Lint / 类型检查

- ESLint：`npm run lint` / `lint:fix`（`eslint --ext .ts,.js,.vue src`）。根 `.eslintrc.cjs` 由 `.eslintrc.base.cjs` 导出 base + TS（标准式，TypeScript-aware, `parserOptions.project: './tsconfig.json'`）覆盖；renderer-lyric 有独立 `.eslintrc.cjs` + `tsconfig.json`。ESLint 也通过 `eslint-webpack-plugin` 在每次 webpack 构建中运行。
- 类型检查：`tsconfig.json`（extends `@tsconfig/recommended`，`allowJs`，`moduleResolution: bundler`）。**实际由编译器完成，tsconfig 主要作为类型参照与编辑查询**。
- 代码风格约定：2 空格缩进、LF、`comma-dangle: always-multiline`、`space-before-function-paren: never`、`prefer-const: off`、允许 `any`、禁止 `tab`。ESLint 规则不要随意放宽。
- 依赖升级注意 `.ncurc.js`：电文清单（electron、vue、vue-router、comlink、undici 等固定版本）。

## 修改代码时的注意事项

- **遵守 IPC 通道规范**：新通道先加进 `src/common/ipcNames.ts` 的命名空间表，再在目标模块注册 handler；渲染端统一走 `src/renderer/utils/ipc.ts` 封装。不要使用硬编码通道。
- **列表 / 播放列表变更**：修改数据要经主进程 IPC（`player_*` / `winMain_*`），且记得前端 `registerListAction` 的镜像订阅。
- **新增语言 key**：`zh-cn.json` / `zh-tw.json` / `en-us.json` 三文件同步修改，否则 i18n 回退到 zh-cn。
- **主题**：新增 CSS 变量进主题生成的 token 集合，需要同步 `src/common/theme/index.json`/createThemes.js 与主进程解析逻辑。
- **User API 相关**：修改脚本执行环境注意沙箱/隔离设置与 webpack external（native modules 不得被 bundled）。
- **DB 变更**：改 `dbService`（tables/migrate/单独模块 service）时递增 `DB_VERSION` 并写 `migrate.ts`。
- **保持 git 提交粒度**：本仓库为上游 fork 开发分支，建议新功能先 Issue；提交前检查 `git diff`。

## 开发环境

- `.vscode/settings.json`：i18n-ally，路径别名 `@main/@renderer/@common/@static`（见 `jsconfig.json`）；vue codeActions 关闭。
- ESLint/Prettier：无需 Prettier（无配置文件）。