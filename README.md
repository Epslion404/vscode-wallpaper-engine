# VS Code Wallpaper Engine

[![Version](https://img.shields.io/visual-studio-marketplace/v/vakesamahere.vscode-wallpaper-engine)](https://marketplace.visualstudio.com/items?itemName=vakesamahere.vscode-wallpaper-engine)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/vakesamahere.vscode-wallpaper-engine)](https://marketplace.visualstudio.com/items?itemName=vakesamahere.vscode-wallpaper-engine)

将 **Wallpaper Engine** 的壁纸带入 VS Code。当前版本：`0.1.2`。

本插件通过在 VS Code 核心文件中注入代码，实现了真正的动态背景支持，并提供了强大的 UI 透明化控制功能，让你在享受动态壁纸的同时，依然保持高效的编码体验。

<img src="assets/preview_1.png" width="600" alt="preview">

<img src="assets/preview_2.png" width="600" alt="preview">

## ✨ 主要功能

- **Wallpaper Engine 支持**: 加载 Steam 创意工坊中的视频、图片和 Web 壁纸；原生 Scene 可自动录制为本地视频缓存后播放。
- **深度透明化**: 不仅仅是简单的透明度，支持对编辑器、侧边栏、面板、终端等 UI 元素进行**精细化的透明度控制**。
- **智能配色**: 自动适配当前主题颜色，支持自定义透明基底颜色，确保在任何主题下都能获得完美的视觉效果。
- **自定义增强**: 支持注入自定义 CSS，微调编辑器外观。
- **状态验证**: 设置过程包含媒体校验、服务健康检查、入口检查、Workbench 注入、透明化和重载后的真实播放确认；视频时间轴开始推进后才报告成功。
- **C/C++ Theme 兼容**: 基础注入始终覆盖现代 UI shell 背景，并可自动识别 `ms-vscode.cpptools-themes` 的 Visual Studio C/C++ 主题执行额外兼容处理。
- **中英双语设置面板**: Wallpaper Settings 支持 `auto`、中文和 English，可运行时切换并持久化。
- **隔离加载**: Web 壁纸运行在 `sandbox="allow-scripts"` 的 iframe 中，不能访问 Workbench DOM。

## 🚀 快速开始

### 前置要求

1.  已安装 **Wallpaper Engine** (Steam 版本)。
2.  使用 Scene 壁纸时，需要可用的 **FFmpeg**，且构建包含 `gdigrab` 和 `libx264`；扩展会优先从 PATH 和常见目录自动检测。
3.  **权限说明**: 首次安装或更新注入时，插件会请求管理员权限 (Sudo) 以修改 VS Code 核心文件，请允许。

### 安装步骤

1.  在 VS Code 插件市场搜索并安装 `vscode-wallpaper-engine`。
2.  **配置壁纸路径**:
    - 打开 VS Code 设置 (`Ctrl+,`)。
    - 搜索 `vscode-wallpaper-engine.workshopPath`。
    - 填入你的 Wallpaper Engine 创意工坊目录路径。
    - _通常路径示例_: `D:/Steam/steamapps/workshop/content/431960`
3.  **设置壁纸**:
    - 按 `F1` 或 `Ctrl+Shift+P` 打开命令面板。
    - 输入并执行 `Set Wallpaper: 设置壁纸`。
    - 从列表中选择一个壁纸。
    - 选择 Scene 时输入录制秒数；留空默认 30 秒，有效范围为 1–300 秒。已有缓存可直接使用或重新录制。
4.  **等待窗口重载与确认**:
    - 插件完成校验和注入后会请求重新加载窗口。
    - 重载后只有在注入标记、壁纸服务、入口文件和实际媒体播放均验证通过时，才会提示壁纸正在播放。
    - 如果没有自动重载，可执行 `Developer: Reload Window` 后查看 `Wallpaper Engine` Output 日志。

## ⚙️ 配置详解

### 核心设置

- `vscode-wallpaper-engine.workshopPath`: Wallpaper Engine 创意工坊文件夹路径 (ID: 431960)。
- `vscode-wallpaper-engine.backgroundOpacity`: 壁纸容器透明度，范围 `0` 到 `1`。
- `vscode-wallpaper-engine.serverPort`: 本地壁纸服务器端口 (默认 23333)。
- `vscode-wallpaper-engine.resizeDelay`: 窗口尺寸变化后刷新 iframe 的延迟时间。
- `vscode-wallpaper-engine.startupCheckInterval`: Workbench 启动时轮询本地服务的间隔。
- `vscode-wallpaper-engine.themeCompatibility`: C/C++ Theme 兼容模式：`auto`（默认，仅检测到冲突主题时启用）、`on`、`off`。
- `vscode-wallpaper-engine.uiLanguage`: Wallpaper Settings 语言：`auto`（跟随 VS Code 语言）、`zh-CN` 或 `en-US`。
- `vscode-wallpaper-engine.wallpaperEnginePath`: Wallpaper Engine 可执行文件路径；留空时自动检测。
- `vscode-wallpaper-engine.ffmpegPath`: FFmpeg 可执行文件路径；留空时自动检测。

### 透明化设置 (Transparency)

本插件使用 `workbench.colorCustomizations` API 来实现非侵入式的 UI 透明化。

- **Enable Transparency**: 全局开启/关闭透明化效果。
- **Transparency Rules**: 精细控制各个 UI 区域的透明度 (0 = 完全透明, 1 = 不透明)。
  - `editor.background`: 代码编辑区
  - `surface.background`: VS Code 现代布局基础表面
  - `sideBar.background`: 侧边栏
  - `panel.background`: 底部面板 (终端/输出)
  - `terminal.background`: 终端背景
  - ...更多
- 规则会保存到打开 Wallpaper Settings 时固定的资源作用域，并使用最高优先级配置（工作区文件夹 > 工作区 > 用户）；即使随后切到设置页或其他编辑器，切换回来仍会保留实际值。
- 设置面板会列出 100 多个编辑器、侧边栏、标签页、终端、列表、弹窗、差异视图等背景项，名称采用“位置描述（键名）”格式，便于在需要时精确定位颜色键。
- 编辑器行号、折叠和断点所在的边栏使用 `editorGutter.background` 控制；若该区域仍有底色，可将该规则设为 `0`。
- 设置面板顶部搜索框可同时搜索透明化规则的位置名称和键名；规则默认按常用程度排列。
- **Base Color**: 透明化的基底颜色。
  - _Auto_: 留空则自动根据当前主题 (深色/浅色) 选择黑色或白色。
  - _Custom_: 输入 Hex 颜色 (如 `#1e1e1e`) 来强制指定基底颜色，解决部分主题下透明后颜色发黑或发白的问题。

### 高级设置

- `vscode-wallpaper-engine.customCss`: 注入自定义 CSS 代码，用于微调界面样式。

### 配置生效范围

- 壁纸路径、壁纸 ID、服务器端口、透明化开关、透明化规则和基底颜色会写入 VS Code 设置。
- Wallpaper Settings 会优先使用当前打开资源的配置作用域（工作区文件夹 > 工作区 > 用户），因此请在目标工作区中打开面板并保存规则。
- 修改壁纸相关配置后，扩展会同步服务器和 Workbench 注入。同一播放类型可热切换；Video、Image、Web 之间切换时会自动重载窗口，以执行对应的新运行时。

## 🎮 使用指南

### 打开设置面板

执行命令 `Open Wallpaper Settings: 打开壁纸设置`，你可以：

- 查看服务器状态。
- 查看当前主题兼容状态和命中的主题名称。
- 一键切换壁纸。
- **可视化调节透明度**: 提供滑块和开关，实时预览配置变更。
- 编辑自定义 CSS。
- 在顶部语言选择器切换中文或 English；选择会保存到用户级设置。

### C/C++ Theme 冲突排查

如果壁纸只在 VS Code 启动瞬间出现、随后变成黑色，通常是 `ms-vscode.cpptools-themes` 的 Visual Studio C/C++ 主题重新设置了现代 UI shell 背景。插件会在 `themeCompatibility=auto` 下自动注入针对性透明规则，不会卸载或禁用该主题扩展。仍有问题时可在设置中手动将 `themeCompatibility` 设为 `on`，并执行一次 `Developer: Reload Window`。

### Scene 自动录制缓存

- Scene 不能直接在浏览器中播放。扩展会让 Wallpaper Engine 在独立命名窗口中渲染，再通过 Windows Graphics Capture 录制临时视频，并由 FFmpeg 转成静音 H.264/MP4 缓存（`yuv420p`、faststart）。
- 缓存保存在扩展的 `globalStorageUri/scene-cache` 中，不修改 Steam 工坊源文件，也不会写入 VSIX。
- 首次选择 Scene 时输入录制时长；留空采用 30 秒。再次选择同一 Scene 时可复用缓存或重新录制。
- 录制支持取消；失败或取消会清理专用窗口和临时文件，并保留上一次有效缓存与当前壁纸。
- Scene 源文件、时长、分辨率或编码参数变化后，旧缓存会自动失效。`0.1.2` 早期开发版生成的 v1 VP8/VP9 WebM 缓存不会兼容读取，请重新选择 Scene 并执行“重新录制”。

### 还原修改并卸载

**⚠️ 重要**: 本插件通过注入 JS/HTML 代码并修改 CSP (内容安全策略) 到 VS Code 核心文件中来实现功能。直接移除插件**不会**自动撤销这些修改。

**请务必先还原修改，再卸载扩展：**

1.  执行命令 `Restore Wallpaper Changes: 还原壁纸修改`。
2.  确认还原，等待扩展清理 Workbench 注入、透明化托管值、本地服务和持久化状态。
3.  窗口重载后，等待“壁纸修改已还原”的最终验证提示；如果提示部分失败，选择“重试”或“查看日志”。
4.  验证通过后，再在扩展管理页面禁用或卸载本扩展。

## ❓ 常见问题 (Troubleshooting)

### 视频壁纸无法播放 / 黑屏？

1. 打开 `Wallpaper Engine` Output，检查 `loadedmetadata`、`canplay`、`playing`、`time-progress` 或明确的媒体错误。
2. 视频和 Scene 缓存通过受限的 `/media/current` 加载；该接口应支持 `HEAD`、字节范围请求和 `206 Partial Content`。若日志显示网络错误，先检查本地端口占用和安全软件拦截。
3. `MEDIA_ERR_DECODE` 或 `MEDIA_ERR_SRC_NOT_SUPPORTED` 才表示需要进一步检查 Electron 的编解码能力；不要在没有该证据时替换 VS Code 的 `ffmpeg.dll`。
4. 如果视频时间轴正常推进但仍不可见，检查主题透明化规则，尤其是 `surface.background`，并重新执行一次设置壁纸以升级 Workbench 注入。

### Scene 无法录制？

1. 在 `Wallpaper Engine` Output 中确认 Wallpaper Engine、FFmpeg 和原生捕获 helper 均已找到。
2. FFmpeg 必须支持 `libx264`；可执行 `ffmpeg -encoders` 检查。
3. 若自动检测失败，在设置中填写 `wallpaperEnginePath` 和 `ffmpegPath`，或在提示中选择对应程序。
4. 录制期间不要最小化或主动关闭 Wallpaper Engine 的专用弹出窗口。
5. 重新选择该 Scene 并选择“重新录制”；旧缓存只有在新录制校验成功后才会被替换。

### 设置完成但壁纸没有显示？

1. 打开 `View: Toggle Output`，在下拉列表选择 `Wallpaper Engine`。
2. 确认日志中的服务健康检查、入口检查、Workbench 注入和 `time-progress` 播放确认均成功。
3. 执行 `Developer: Reload Window`；VS Code 更新后可能覆盖注入，需要重新执行 `Set Wallpaper: 设置壁纸`。
4. 检查 `vscode-wallpaper-engine.serverPort` 是否被其他进程占用。
5. 若出现 `watchdog-timeout`、`play-rejected`、`media-error` 或播放确认超时，按日志中的具体阶段排查；失败的待确认记录会保留用于诊断，但不会循环重载窗口。

### 设置面板语言没有更新？

在 Wallpaper Settings 顶部选择 `Auto`、`中文` 或 `English`。该值保存到用户级配置；直接修改 `vscode-wallpaper-engine.uiLanguage` 时，已打开的设置面板也会同步刷新。

### 壁纸只在启动瞬间出现，随后变黑？

当前修复同时处理媒体格式、启动恢复、服务接管、模块缓存和界面遮挡：Scene 缓存使用 H.264/MP4；Video/Image 等待本地服务后再加载并执行有界重试；Reload Window 后新 Extension Host 会接管原端口；实际 `workbench.js` 入口使用扩展管理的查询参数绕过 Electron 模块缓存；现代布局基础表面 `surface.background` 纳入透明化。Workbench 注入协议已升级到 `6`，升级后需要重新执行一次“设置壁纸”。若日志显示视频已 `time-progress` 但仍不可见，再检查 C/C++ Theme 等主题兼容设置。

## 🛠️ 开发与发布

```powershell
npm install
npm run build:scene-helper # 仅在修改 native helper 后执行，需要 Rust stable
npm run check-types
npm run lint
npm test -- --runInBand
npm run vsce-package
```

`npm run vsce-package` 会先执行生产构建，再在项目根目录生成 `vscode-wallpaper-engine-<version>.vsix`。发布前请确认 `package.json` 与 `package-lock.json` 版本一致，并使用 `git diff --check` 检查空白错误。仓库默认忽略 VSIX 文件；需要交付时可将产物归档到 `release/`，并记录 SHA-256。

## 📁 项目结构

- `src/extension.ts`: 扩展生命周期、命令注册、设置壁纸和还原流程。
- `src/core/injector.ts`: Workbench HTML/JS 注入、CSP 本地来源补丁和沙箱 iframe 引导。
- `src/core/server.ts`、`src/core/server-media.ts`: 仅监听 `127.0.0.1` 的本地壁纸服务、当前媒体 Range 传输及健康检查接口。
- `src/core/playback-monitor.ts`: Workbench 媒体事件与服务端播放状态的严格边界校验。
- `src/core/config-patcher.ts`: 透明化规则、主题兼容和托管配置备份。
- `src/core/scene-recorder.ts`、`src/core/scene-cache.ts`: Scene 录制编排、缓存清单与校验。
- `native/scene-capture-helper`: Windows Graphics Capture 原生 helper 源码；发布包使用 `bin/` 中的已构建程序。
- `src/panels/setting-panel.ts`、`media/settings.*`: Wallpaper Settings 面板及中英文本地化。
- `docs/COMMUNICATION.md`: Workbench、扩展宿主、本地服务与壁纸 iframe 的通信约定。

## ⚠️ 免责声明

本插件通过修改 VS Code 安装目录下的核心文件 (`workbench.html` 等) 来实现功能。虽然我们尽力确保稳定性，但：

- VS Code 更新后，注入的代码可能会被覆盖，需要重新运行设置壁纸命令。
- 如果 VS Code 提示 "Installation appears to be corrupt" (安装似乎已损坏)，这是正常现象，点击 "不再提示" 即可，或者点击齿轮图标选择 "Don't show again"。
- 请自行承担使用风险。

## 📝 更新日志

请查看 [CHANGELOG.md](CHANGELOG.md) 获取最新更新信息。

---

**Enjoy your coding with live wallpapers!** 🎨

## ☕️ Buy Me A Coffee (支持作者)

<img src="assets/wechat_pay.jpg" width="200" alt="wechat_pay">
