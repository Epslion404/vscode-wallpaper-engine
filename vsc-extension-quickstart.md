# 开发与维护指南

本文档面向 `vscode-wallpaper-engine` 的开发者和维护者。用户安装与故障排查请先阅读 [README.md](README.md)。

## 环境准备

1. 安装 VS Code（需满足 `package.json` 中声明的 VS Code 引擎版本）。
2. 安装 Node.js 和 npm。
3. 克隆仓库并安装依赖：

   ```powershell
   npm install
   ```

## 代码结构

- `src/extension.ts`：扩展激活、命令、配置监听、设置/还原事务。
- `src/core/injector.ts`：Workbench HTML/JavaScript 注入、CSP 来源补丁和沙箱 iframe。
- `src/core/server.ts`：本地壁纸 HTTP 服务、入口和属性接口。
- `src/core/scanner.ts`：创意工坊 `project.json` 扫描与诊断。
- `src/core/config-patcher.ts`：透明化规则、主题兼容和托管值备份。
- `src/panels/setting-panel.ts`、`media/settings.*`：Wallpaper Settings Webview 和本地化文本。
- `src/test/`：单元测试与集成测试。

## 日常开发

类型检查、Lint 和开发构建：

```powershell
npm run check-types
npm run lint
npm run compile
```

监听模式：

```powershell
npm run watch
```

按 `F5` 启动 Extension Development Host，然后从命令面板执行 Wallpaper Engine 命令。扩展输出位于 `View: Toggle Output` 的 `Wallpaper Engine` 通道。

## 测试

运行完整测试套件：

```powershell
npm test -- --runInBand
```

提交前至少执行：

```powershell
npm run check-types
npm run lint
npm test -- --runInBand
git diff --check
```

修改注入、服务器安全、扫描器或卸载流程时，应同步补充 `src/test/` 中对应的回归测试。

## 打包与发布

1. 修改 `package.json` 的版本号，并同步 `package-lock.json` 顶层版本和 `packages[""]`.version。
2. 在 `CHANGELOG.md` 顶部记录版本、日期和用户可见变更。
3. 执行：

   ```powershell
   npm run vsce-package
   ```

   该命令会运行 `vscode:prepublish`，依次执行生产构建、类型检查和 Lint，然后在项目根目录生成 `vscode-wallpaper-engine-<version>.vsix`。
4. 交付产物可移动到 `release/` 并计算 SHA-256：

   ```powershell
   Move-Item .\vscode-wallpaper-engine-<version>.vsix .\release\
   Get-FileHash -Algorithm SHA256 .\release\vscode-wallpaper-engine-<version>.vsix
   ```

   VSIX 默认被 `.gitignore` 排除，源码提交不应强制加入二进制文件。
5. 提交并推送前检查：

   ```powershell
   git status --short
   git log -1 --oneline
   git push origin master
   ```

如网络环境需要代理，在 Git 命令中显式设置 `http.proxy` 和 `https.proxy`，不要把代理凭据写入仓库配置或文档。

## 修改 Workbench 注入时的注意事项

- 只向 VS Code 原 CSP 的 `frame-src` 和 `connect-src` 增加当前回环端口，不得恢复全开放策略。
- Web 壁纸 iframe 必须保持 `sandbox="allow-scripts"`，不要添加 `allow-same-origin`。
- 文件服务必须使用真实路径边界校验，不能用简单的字符串前缀判断路径是否安全。
- 还原流程需要清理注入标记、CSP 来源、插件托管透明化备份、本地服务和持久化状态，并覆盖重载后的验证。
- 修改配置键时同步更新 `src/config`、`src/configuration-change.ts`、`package.json` 和相关测试。

## 版本记录

当前版本为 `0.1.2`。用户可见变更统一记录在 [CHANGELOG.md](CHANGELOG.md)；通信协议和本地接口记录在 [docs/COMMUNICATION.md](docs/COMMUNICATION.md)。
