# VS Code Wallpaper Engine 通信机制

本文档描述扩展宿主、Workbench 注入脚本、本地壁纸服务和沙箱壁纸页面之间的边界与消息流。代码实现以 `src/extension.ts`、`src/core/injector.ts`、`src/core/server.ts` 和 `src/panels/setting-panel.ts` 为准。

## 1. 组件与安全边界

系统由五个部分组成：

1. **Extension Host**：运行扩展宿主中的 Node.js 代码，负责生命周期、配置、透明化规则、本地服务器和 Workbench 文件修改。
2. **Workbench 注入脚本**：运行在 VS Code 主窗口，用于创建壁纸容器、同步透明化 CSS 和向壁纸 iframe 发送运行时消息。
3. **本地壁纸服务器**：由 Extension Host 启动，默认只监听 `127.0.0.1:23333`，提供壁纸入口、项目配置和健康检查接口。
4. **壁纸 iframe**：使用 `sandbox="allow-scripts"` 加载 Web 壁纸入口。未授予 `allow-same-origin`，因此壁纸脚本不能读取或修改 Workbench DOM，也不能直接访问扩展宿主。
5. **Scene 捕获 helper**：仅在录制原生 Scene 时启动，使用 Windows Graphics Capture 捕获指定的 Wallpaper Engine 命名窗口；完成后由 FFmpeg 转为 VP9/WebM，helper 不接触 Workbench 或本地 HTTP 服务。

Workbench 原有 Content-Security-Policy 会被保留。注入只向 `frame-src`、`connect-src` 和 `media-src` 增加当前端口的 `http://127.0.0.1:<port>`，不会恢复旧版的全开放 CSP。注入脚本通过基础 CSS 和节流的 DOM 观察持续覆盖 modern UI shell 的背景变量及 `.monaco-grid-view`，主题兼容模式只负责额外的 C/C++ Theme 适配。注入代码带有协议版本标记，升级或还原时可识别并清理旧注入。

## 2. 初始化与壁纸加载

1. 扩展激活后读取配置，并按需要启动本地服务器。
2. 设置壁纸命令扫描创意工坊目录中的 `project.json`。`video`、`image`、`web` 和 `scene` 均进入候选列表，标题和工坊 ID 都可搜索。
3. 选择 Scene 后，扩展检查 `globalStorageUri/scene-cache`：已有有效缓存可直接复用或重新录制；无缓存时输入 1–300 秒，留空默认 30 秒。
4. 录制时 Wallpaper Engine 通过 `openWallpaper` 在唯一命名窗口中渲染；原生 helper 捕获该窗口，FFmpeg 转为静音 VP9/WebM 并执行视频流、时长、尺寸和黑帧验证。成功后原子提交缓存，失败或取消保留旧缓存。
5. Scene 缓存随后按普通 Video 进入既有设置事务。服务器依次验证媒体、服务健康状态和 `/api/get-entry` 入口。
6. 扩展补丁 Workbench HTML 的 CSP，再把引导代码注入 `workbench.desktop.main.js`，最后请求窗口重载。
7. 注入脚本创建 `#vscode-wallpaper-container`。壁纸层使用 `z-index: 0`，Workbench 根层使用独立的 `z-index: 1` stacking context；容器被后加载布局移除时只执行有界、幂等恢复。
8. 视频、Scene 缓存和图片壁纸通过固定的 `/media/current` 加载；Web 壁纸通过本地服务的 `/api/get-entry` 加载。
9. Workbench 将有界的加载、播放和错误状态提交到 `/playback-event`。视频只有在 `playing` 后 `currentTime` 确实推进才进入 ready；重载后的 Extension Host 通过 `/playback-status` 确认后才报告成功。

## 3. 本地 HTTP 接口

所有接口只用于本机 Workbench 与壁纸运行时通信。服务绑定回环地址；响应按接口需要设置 CORS，不能据此把服务视为可供局域网访问的通用文件服务器。

| 接口 | 用途 |
| --- | --- |
| `GET /ping` | 健康检查。普通请求返回 `200 pong`；切换壁纸时可返回一次 `205`，通知客户端重新加载 iframe。 |
| `GET /status` | 返回服务是否运行、当前壁纸根目录和入口文件，用于端口复用检查。 |
| `GET /config` | 返回当前 CSS 配置（例如 `customCss`、`themeCompatibility`），供注入脚本同步样式。 |
| `GET /api/get-entry` | 返回视频、图片或 Web 壁纸的可加载入口 HTML。 |
| `GET/HEAD /media/current` | 只读取服务端当前播放条目；支持单 Range、`200/206/416`、正确 MIME 和长度，不接受路径参数。 |
| `POST /playback-event` | 接收 Workbench 上报的有界媒体状态；请求体和诊断字段均有限制。 |
| `GET /playback-status` | 返回最新播放快照或 `idle`，供重载后的 Extension Host 确认真实播放状态。 |
| `GET /project.json` | 合并当前壁纸及依赖目录的项目属性，供壁纸属性面板使用。 |
| `GET /proxy?url=...` | 为壁纸兼容层代理公开网络资源。只接受 `http`/`https`，拒绝私网或回环地址、DNS 解析到私网的目标和重定向；单请求超时 10 秒，响应上限 10 MiB。 |
| `GET /shutdown` | 本地服务接管时使用的关闭信号，不应由壁纸页面主动调用。 |

文件请求会经过真实路径校验，只允许落在当前壁纸目录或已解析的依赖目录内；路径穿越、符号链接越界和目录外文件不会被返回。

## 4. Workbench 与壁纸 iframe 消息

注入脚本会向 iframe 发送以下运行时消息。由于 `sandbox` iframe 使用 opaque origin，消息目标使用 `*`；消息只发送到扩展创建并持有引用的 iframe。

```ts
{ type: 'UPDATE_PROPERTIES', data: { [key]: { value } } }
{ type: 'PROPERTIES', data: { [key]: { value } } }
{ type: 'AUDIO_TICK', data: { ...audioState } }
```

壁纸兼容层通过 `window.parent.postMessage` 回传音频源等请求；注入脚本只处理预定义消息类型，不把任意消息拼接进 Workbench 主脚本。

## 5. 设置面板消息

Wallpaper Settings 是独立 Webview。打开后先发送 `{ command: "ready" }`，Extension Host 返回当前状态：

- `{ type: "setupState", state }`：设置阶段、运行状态、成功或错误信息。
- `{ type: "compatibilityStatus", state }`：C/C++ Theme 兼容模式、是否启用、命中原因和主题名称。
- `{ type: "language", language, resolvedLanguage }`：配置值和 `auto` 解析后的界面语言。

用户切换语言时发送：

```ts
{ command: 'setLanguage', language: 'auto' | 'zh-CN' | 'en-US' }
```

Host 会校验枚举值并写入用户级设置。透明化规则、开关和基底颜色则按当前资源作用域（工作区文件夹 > 工作区 > 用户）保存，并在写入后把后端确认值回传给面板。

## 6. 刷新、重载与还原

- 修改壁纸或服务器端口时，扩展会保存待确认事务，并在注入完成后请求 `workbench.action.reloadWindow`。
- 重载后的激活流程会验证注入标记、服务健康、壁纸入口和真实媒体 ready；任一项失败都会保留错误状态，便于查看 `Wallpaper Engine` Output 日志。
- Reload Window 关闭旧 Extension Host 时产生的精确取消错误属于正常事务移交，不触发配置回滚或虚假失败提示。
- Scene 会持久化实际缓存视频的根目录、入口和 `Video` 播放类型；重载恢复、配置重应用和失败回滚不会把原始 `scene.pkg` 直接送入 Workbench。
- 执行“还原壁纸修改”时，扩展会停止服务、移除 Workbench 注入、恢复 CSP、删除插件托管的透明化备份和持久化状态，再通过重载后的验证确认清理完成。
- VS Code 更新可能覆盖 Workbench 文件。此时需要重新执行“设置壁纸”；若不再使用扩展，应先执行还原命令并等待验证通过，再卸载扩展。

## 7. 常见连接问题

1. **服务未启动或端口冲突**：查看 `Wallpaper Engine` Output 中的 `/status` 和监听错误，修改 `serverPort` 后重新设置壁纸。
2. **CSP 或注入标记缺失**：VS Code 更新后核心文件可能恢复原状，重新执行设置壁纸即可重新补丁。
3. **启动瞬间可见、随后变黑**：先根据 `/playback-status` 区分“媒体未播放”和“媒体已播放但被遮挡”。前者查看 `media-error`、`play-rejected`、`watchdog-timeout`；后者检查 `surface.background`、容器层级和主题兼容状态。
4. **属性面板无内容**：确认当前壁纸包含可解析的 `project.json`，并检查本地服务是否能访问 `/project.json`。

## 8. 时序图

```mermaid
sequenceDiagram
    participant Ext as Extension Host
    participant WE as Wallpaper Engine Scene Window
    participant Cap as WGC Capture Helper
    participant WB as Workbench 注入脚本
    participant S as 127.0.0.1 壁纸服务
    participant IF as sandbox iframe

    opt 选择 Scene 且需要录制
        Ext->>WE: openWallpaper(playInWindow)
        Ext->>Cap: 按唯一窗口名录制
        Cap-->>Ext: 临时视频
        Ext->>Ext: FFmpeg 转码、验证并提交缓存
        Ext->>WE: closeWallpaper(location)
    end
    Ext->>S: 启动并监听端口
    Ext->>WB: 注入引导脚本与受限 CSP 来源
    WB->>S: GET /ping
    S-->>WB: 200 pong
    WB->>S: GET /api/get-entry
    S-->>WB: 壁纸入口 HTML
    WB->>S: GET /media/current (HEAD/Range)
    S-->>WB: 200/206 媒体流
    WB->>S: POST /playback-event
    Ext->>S: GET /playback-status
    S-->>Ext: ready / error / loading
    WB->>IF: sandbox 加载入口
    WB->>S: GET /config /project.json
    S-->>WB: CSS 与壁纸属性
    WB->>IF: postMessage(UPDATE_PROPERTIES / AUDIO_TICK)
```
