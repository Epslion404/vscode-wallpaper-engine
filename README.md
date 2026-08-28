# VS Code Wallpaper Engine

[![Version](https://img.shields.io/visual-studio-marketplace/v/vakesamahere.vscode-wallpaper-engine)](https://marketplace.visualstudio.com/items?itemName=vakesamahere.vscode-wallpaper-engine)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/vakesamahere.vscode-wallpaper-engine)](https://marketplace.visualstudio.com/items?itemName=vakesamahere.vscode-wallpaper-engine)

将 **Wallpaper Engine** 的壁纸带入 VS Code。当前版本：`0.0.11`。

本插件通过在 VS Code 核心文件中注入代码，实现了真正的动态背景支持，并提供了强大的 UI 透明化控制功能，让你在享受动态壁纸的同时，依然保持高效的编码体验。

<img src="assets/preview_1.png" width="600" alt="preview">

<img src="assets/preview_2.png" width="600" alt="preview">

## ✨ 主要功能

- **Wallpaper Engine 支持**: 加载 Steam 创意工坊中的视频、图片和 Web 类型壁纸；原生 Scene 类型暂不支持。
- **深度透明化**: 不仅仅是简单的透明度，支持对编辑器、侧边栏、面板、终端等 UI 元素进行**精细化的透明度控制**。
- **智能配色**: 自动适配当前主题颜色，支持自定义透明基底颜色，确保在任何主题下都能获得完美的视觉效果。
- **自定义增强**: 支持注入自定义 CSS，微调编辑器外观。
- **状态验证**: 设置过程包含媒体校验、服务健康检查、入口检查、Workbench 注入、透明化和重载后确认。
- **C/C++ Theme 兼容**: 自动识别 `ms-vscode.cpptools-themes` 的 Visual Studio C/C++ 主题，避免现代 UI shell 在加载完成后覆盖壁纸。
- **中英双语设置面板**: Wallpaper Settings 支持 `auto`、中文和 English，可运行时切换并持久化。
- **隔离加载**: Web 壁纸运行在 `sandbox="allow-scripts"` 的 iframe 中，不能访问 Workbench DOM。

## 🚀 快速开始

### 前置要求

1.  已安装 **Wallpaper Engine** (Steam 版本)。
2.  **权限说明**: 首次安装或更新注入时，插件会请求管理员权限 (Sudo) 以修改 VS Code 核心文件，请允许。

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
4.  **等待窗口重载与确认**:
    - 插件完成校验和注入后会请求重新加载窗口。
    - 重载后只有在注入标记、壁纸服务和入口文件均验证通过时，才会提示壁纸已生效。
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

### 透明化设置 (Transparency)

本插件使用 `workbench.colorCustomizations` API 来实现非侵入式的 UI 透明化。

- **Enable Transparency**: 全局开启/关闭透明化效果。
- **Transparency Rules**: 精细控制各个 UI 区域的透明度 (0 = 完全透明, 1 = 不透明)。
  - `editor.background`: 代码编辑区
  - `sideBar.background`: 侧边栏
  - `panel.background`: 底部面板 (终端/输出)
  - `terminal.background`: 终端背景
  - ...更多
- 规则会保存到打开 Wallpaper Settings 时固定的资源作用域，并使用最高优先级配置（工作区文件夹 > 工作区 > 用户）；即使随后切到设置页或其他编辑器，切换回来仍会保留实际值。
- **Base Color**: 透明化的基底颜色。
  - _Auto_: 留空则自动根据当前主题 (深色/浅色) 选择黑色或白色。
  - _Custom_: 输入 Hex 颜色 (如 `#1e1e1e`) 来强制指定基底颜色，解决部分主题下透明后颜色发黑或发白的问题。

### 高级设置

- `vscode-wallpaper-engine.customCss`: 注入自定义 CSS 代码，用于微调界面样式。

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

### 还原修改并卸载

**⚠️ 重要**: 本插件通过注入 JS/HTML 代码并修改 CSP (内容安全策略) 到 VS Code 核心文件中来实现功能。直接移除插件**不会**自动撤销这些修改。

**请务必先还原修改，再卸载扩展：**

1.  执行命令 `Restore Wallpaper Changes: 还原壁纸修改`。
2.  确认还原，等待扩展清理 Workbench 注入、透明化托管值、本地服务和持久化状态。
3.  窗口重载后，等待“壁纸修改已还原”的最终验证提示；如果提示部分失败，选择“重试”或“查看日志”。
4.  验证通过后，再在扩展管理页面禁用或卸载本扩展。

## ❓ 常见问题 (Troubleshooting)

### 视频壁纸无法播放 / 黑屏？

VS Code 内置的 Electron 环境默认携带的 `ffmpeg.dll` 是精简版，不支持 WebM 等常见视频格式。

**解决方法**:

1.  检查你的 VS Code 版本对应的 Electron 版本 (Help -> About -> Electron)。
2.  下载对应 Electron 版本的完整版 `ffmpeg.dll`。
3.  替换 VS Code 安装目录下的 `ffmpeg.dll` 文件。

### 设置完成但壁纸没有显示？

1. 打开 `View: Toggle Output`，在下拉列表选择 `Wallpaper Engine`。
2. 确认日志中的服务健康检查、入口检查和 Workbench 注入均成功。
3. 执行 `Developer: Reload Window`；VS Code 更新后可能覆盖注入，需要重新执行 `Set Wallpaper: 设置壁纸`。
4. 检查 `vscode-wallpaper-engine.serverPort` 是否被其他进程占用。

### 启动时一闪而过，随后变成黑色？

启用 C/C++ Theme 时，保持 `vscode-wallpaper-engine.themeCompatibility` 为 `auto`。设置面板会显示当前主题兼容状态；若未被自动识别，可临时设为 `on` 并重新加载窗口。不要通过卸载主题扩展来规避问题。

### 设置面板语言没有更新？

在 Wallpaper Settings 顶部选择 `Auto`、`中文` 或 `English`。该值保存到用户级配置；直接修改 `vscode-wallpaper-engine.uiLanguage` 时，已打开的设置面板也会同步刷新。

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
