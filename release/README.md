# Release 状态

## v0.2.1

当前推荐版本。Scene 录制优先使用不激活的静默捕获；Chromium 因页面隐藏暂停无音轨视频时，扩展会保留媒体源并在窗口恢复可见后继续播放，不再误报 `retry-exhausted`。

安装文件：`vscode-wallpaper-engine-0.2.1.vsix`

## v0.2.0

历史版本。新增 Scene 自动录制缓存、媒体启动与服务接管，但设置或重载期间页面隐藏时，无音轨视频可能因 Chromium 后台节能暂停而被误报为播放失败，建议升级到 `v0.2.1`。

安装文件：`vscode-wallpaper-engine-0.2.0.vsix`

## v0.1.2

旧稳定版本，修复 Workbench 动态主题样式覆盖透明规则导致的启动后黑屏，并升级注入协议到 `4`。建议升级到 `v0.2.1`。

安装文件：`vscode-wallpaper-engine-0.1.2.vsix`

## v0.1.1

**严重缺陷，不可用。**该版本仍可能在 Workbench 动态样式加载后出现黑屏，请改用 `v0.2.1`。

安装文件：`vscode-wallpaper-engine-0.1.1.vsix`

## v0.1.0

**严重缺陷，不可用。**

已知问题：更换壁纸或重载窗口后，壁纸可能只在 VS Code 启动瞬间出现，随后被 Workbench 的现代 UI shell 不透明背景覆盖。请勿继续使用 `vscode-wallpaper-engine-0.1.0.vsix`，改用 `v0.2.1`。
