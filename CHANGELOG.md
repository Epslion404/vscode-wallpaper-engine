# Change Log

All notable changes to the "vscode-wallpaper-engine" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
