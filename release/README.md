# Release 状态

## v0.2.0

当前推荐版本。新增 Scene 自动录制缓存、稳定的媒体启动与服务接管，并修复播放已恢复时仍因陈旧或瞬态 `play-rejected` 快照误报失败的问题。

安装文件：`vscode-wallpaper-engine-0.2.0.vsix`

## v0.1.2

旧稳定版本，修复 Workbench 动态主题样式覆盖透明规则导致的启动后黑屏，并升级注入协议到 `4`。建议升级到 `v0.2.0`。

安装文件：`vscode-wallpaper-engine-0.1.2.vsix`

## v0.1.1

**严重缺陷，不可用。**该版本仍可能在 Workbench 动态样式加载后出现黑屏，请改用 `v0.1.2`。

安装文件：`vscode-wallpaper-engine-0.1.1.vsix`

## v0.1.0

**严重缺陷，不可用。**

已知问题：更换壁纸或重载窗口后，壁纸可能只在 VS Code 启动瞬间出现，随后被 Workbench 的现代 UI shell 不透明背景覆盖。请勿继续使用 `vscode-wallpaper-engine-0.1.0.vsix`，改用 `v0.1.2`。
