# Change Log

All notable changes to the "vscode-wallpaper-engine" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.0] - 2026-08-28

### Added

- 透明化规则表支持按位置名称、英文名称和颜色键名查询，并按常用程度默认排序。
- 新增编辑器行号、折叠和断点边栏背景 `editorGutter.background` 的透明化控制。
- 透明化规则名称统一显示为“位置描述（键名）”，并支持中英文界面切换。

### Fixed

- 改进 Wallpaper Settings 规则表的筛选与回显体验，便于快速定位和调整透明化目标。

### Documentation

- README、通信机制文档和开发向导已同步到 `0.1.0` 的安装、排障、沙箱隔离、接口限制及打包流程。

## [0.0.13] - 2026-08-28

### Added

- 扩展透明化规则列表，覆盖编辑器、标签页、侧边栏、活动栏、面板、状态栏、弹窗、列表树、最小地图、终端、设置、聊天和差异编辑器等区域。
- 透明化规则名称改为“位置描述（键名）”，并支持中英文切换。
- 新增编辑器行号、折叠和断点边栏背景 `editorGutter.background` 的透明化控制。
- 设置面板搜索框现在同时支持按规则位置名称和颜色键名查询，规则默认按常用程度排序。

## [0.0.12] - 2026-08-28

### Fixed

- 修复 Wallpaper Settings 透明化规则在工作区文件夹作用域下保存后回显旧值的问题。
- 修复切换到设置页或其他编辑器后，面板重开因活动资源变化而读取旧规则的问题。
- 增大透明化规则滑块，并在窄窗口中自适应显示。

## [0.0.11] - 2026-08-28

### Added

- Wallpaper Settings 新增 `auto`、中文、English 三种界面语言，可即时切换并持久化。
- 新增 `themeCompatibility` 配置，自动识别并兼容 C/C++ Theme 的现代 UI shell 背景覆盖。
- 设置面板显示当前主题兼容状态、命中原因和主题名称。

### Fixed

- 修复启用 `ms-vscode.cpptools-themes` 后壁纸在 Workbench 完成加载时被黑色背景覆盖的问题。
- 修复工作区文件夹级透明化规则被错误写入用户级配置，导致切换 Wallpaper Settings 后规则恢复旧值的问题。
- 保存透明化规则后，设置面板立即使用后端确认的持久化值重绘；透明化规则滑块宽度增至 200px，并在窄窗口中自适应。
- 统一设置过程常见状态、错误和固定控件的中英文反馈。

### Documentation

- 更新安装、重载确认、故障排查、还原卸载和沙箱隔离说明，使文档与 `0.0.11` 行为一致。

## [0.0.10] - 2026-08-28

### Fixed

- 修复现代 UI shell 的 `.monaco-grid-view` 不透明背景覆盖视频壁纸，导致启动瞬间可见、加载完成后变黑。
- 注入时强制覆盖 `--modern-ui-shell-background` 并保持 Workbench 根层透明。
- 增加注入协议版本标记，升级后自动迁移旧版 Workbench 注入。

## [0.0.9] - 2026-08-28

### Fixed

- 修复重装后旧 `pendingUninstall` 优先级错误导致的新壁纸生效误报。
- 仅允许时间更新且壁纸 ID、目录、入口一致的设置事务取代旧还原事务。
- 用户真正选定壁纸后才清除旧还原状态；取消选择或前置失败不会误启用扩展。
- 增加事务迁移、路径规范化和 pending setup 结构校验回归测试。

## [0.0.8] - 2026-08-28

### Fixed

- 修复设置壁纸触发窗口重载时，`deactivate()` 错误清除注入、透明化和本地服务的问题。
- 激活时恢复壁纸服务，并在 Workbench 注入缺失时自动修复后请求一次重载。
- 重载后的成功提示现在要求注入标记、服务健康和壁纸入口全部验证通过。
- 保留失败的待确认记录，便于用户重试或查看诊断日志。

## [0.0.7] - 2026-08-28

### Fixed

- Completed the restore workflow with lifecycle locking, cross-reload verification, and best-effort cleanup.
- Improved restore progress and partial-failure feedback with retry and log actions.
- Preserved user color customizations while restoring plugin-managed transparency in Global and Workspace scopes.

## [0.0.6] - 2026-08-28

### Fixed

- Hardened wallpaper loading, local file serving, proxy requests, and Workbench injection boundaries.
- Improved wallpaper setup progress, failure recovery, refresh feedback, and settings-page status reporting.
- Added safer configuration validation, transparency restoration, scanner diagnostics, and reproducible packaging.

## [0.0.5] - 2025-12-31

### Fixed

- There will be no black background when no editor is active

## [0.0.4] - 2025-12-06

### Added

- **Transparency**: Expanded transparency support for more UI elements including Title Bar, Notifications, Menus, Quick Input, and Status Bar items.

### Fixed

- **Settings Panel**: Fixed an issue where transparency settings appeared to reset when reopening the panel due to workspace settings shadowing global configuration.
- **Core**: Fixed workbench background transparency by injecting CSS rule for `div[role="application"]` via JS.

## [0.0.3] - 2025-11-23

### Added

- **Settings Panel**: Added "Open Wallpaper Folder" button to quickly access the wallpaper directory.
- **Settings Panel**: Added "Wallpaper Info" section displaying Name, Type, Entry File, and Path.
- **Debug Sidebar**: Added "Open Wallpaper Folder" button.

### Fixed

- **Core**: Fixed `net::ERR_FILE_NOT_FOUND` for relative paths in wallpapers by injecting `<base>` tag.
- **Core**: Fixed `SecurityError: Tainted canvases` in WebGL wallpapers by forcing `crossOrigin="anonymous"` on media elements.
- **Core**: Fixed Regex syntax errors in injected script due to incorrect backslash escaping.
- **UI**: Fixed Settings Panel sliders and switches color to match VS Code theme button color.

## [0.0.2] - 2025-11-23

### Fixed

- **Server**: Fixed `EADDRINUSE` error where the wallpaper server port (23333) remained occupied after reload (Zombie Server issue).
- **Web Wallpapers**: Fixed `api/get-entry` 404 error for wallpapers with dependencies (e.g. `index.html` in a referenced folder).
- **Persistence**: Fixed issue where wallpaper type (Video/Web) was lost after VS Code restart.

## [0.0.1] - Initial Release

- Basic Wallpaper Engine support (Video, Image, Web).
- Transparency patch.
