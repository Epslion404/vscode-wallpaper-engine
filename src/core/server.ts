import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { WebSocket, WebSocketServer } from 'ws';
import { WALLPAPER_SERVER_PORT } from '../config/constants';
import { MOCK_API_SCRIPT, BOOTSTRAP_SCRIPT } from './web-api-mock';
import { assertPublicAddress, isPathWithinRealRoot, validateProxyTarget } from './server-security';
import {
    requestLocalEndpoint,
    validateWallpaperMedia,
    waitForServerListening,
    WallpaperPreflightError,
    WallpaperServerStartupTimeoutError
} from './server-preflight';
import { PENDING_SETUP_CONFIRMATION_KEY } from './wallpaper-setup';
import { CURRENT_PLAYBACK_STATE_KEY } from './playback-state';
import {
    parsePlaybackReport,
    parsePlaybackStatus,
    PlaybackMediaType,
    PlaybackMonitor
} from './playback-monitor';
import { serveCurrentMedia } from './server-media';
import {
    scheduleTakeoverTask,
    ServerTakeoverEvent,
    ServerTakeoverMonitor
} from './server-takeover';

export { validateWallpaperMedia, waitForServerListening, WallpaperServerStartupTimeoutError } from './server-preflight';

const SERVER_STARTUP_TIMEOUT_MS = 5000;
const SERVER_PREFLIGHT_TIMEOUT_MS = 3000;
const PLAYBACK_READY_TIMEOUT_MS = 10000;
const PLAYBACK_STATUS_POLL_INTERVAL_MS = 100;
const PLAYBACK_STATUS_RESPONSE_LIMIT = 4 * 1024;
const PLAYBACK_EVENT_BODY_LIMIT = 4 * 1024;
const WALLPAPER_SERVICE_ID = 'vscode-wallpaper-engine';
const WALLPAPER_SERVICE_PROTOCOL_VERSION = 1;
const SERVER_STATUS_RESPONSE_LIMIT = 8 * 1024;
const SERVER_TAKEOVER_POLL_INTERVAL_MS = 500;

const PERSISTED_WALLPAPER_STATE_KEYS = [
    'currentWallpaperPath',
    'currentWallpaperEntry',
    'currentWallpaperLocation',
    CURRENT_PLAYBACK_STATE_KEY,
    PENDING_SETUP_CONFIRMATION_KEY
] as const;

export class PersistedWallpaperStateError extends Error {
    public constructor(
        public readonly failures: ReadonlyArray<{ key: string; error: unknown }>
    ) {
        super(`壁纸持久状态清理失败（${failures.length} 项）`);
        this.name = 'PersistedWallpaperStateError';
    }
}

class WallpaperServerOperationCancelledError extends Error {
    public constructor() {
        super('壁纸服务操作已被新的生命周期请求取代');
        this.name = 'WallpaperServerOperationCancelledError';
    }
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type ProjectProperties = Record<string, JsonObject>;

type BoundedBodyResult = { kind: 'ok'; body: string } | { kind: 'too-large' };

type WallpaperServiceStatus = {
    kind: 'wallpaper';
    running: true;
    rootPath: string;
    entryFile: string | null;
    instanceId: string;
};

type ServerStatusProbe = WallpaperServiceStatus | { kind: 'absent' } | { kind: 'occupied' };
type ServerOwnership = 'none' | 'external' | 'local';
type RemoteShutdownResult = 'accepted' | 'owner-changed' | 'unreachable';
type PendingServer = {
    generation: number;
    server: http.Server;
    wss: WebSocketServer | null;
};
type LifecycleOperation = {
    generation: number;
    signal: AbortSignal;
};

export interface WallpaperServerOptions {
    takeoverPollIntervalMs?: number;
    scheduleShutdownTask?: (task: () => Promise<void>) => void;
}

export class WallpaperServerConflictError extends Error {
    public constructor(port: number) {
        super(`端口 ${port} 正由另一个窗口用于不同壁纸`);
        this.name = 'WallpaperServerConflictError';
    }
}

async function readBoundedBody(request: http.IncomingMessage, maxBytes: number): Promise<BoundedBodyResult> {
    const declaredLength = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        request.resume();
        return { kind: 'too-large' };
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        total += buffer.byteLength;
        if (total > maxBytes) {
            request.resume();
            return { kind: 'too-large' };
        }
        chunks.push(buffer);
    }
    return { kind: 'ok', body: Buffer.concat(chunks).toString('utf-8') };
}

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    return typeof value === 'object'
        && value !== null
        && Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
    return isJsonValue(value) && typeof value === 'object' && !Array.isArray(value);
}

function readProjectJson(filePath: string): JsonObject | undefined {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return isJsonObject(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function readProjectProperties(content: JsonObject): ProjectProperties {
    const candidate = isJsonObject(content.properties)
        ? content.properties
        : isJsonObject(content.general) && isJsonObject(content.general.properties)
            ? content.general.properties
            : undefined;
    if (!candidate) {
        return {};
    }

    const properties: ProjectProperties = {};
    for (const [key, value] of Object.entries(candidate)) {
        if (isJsonObject(value)) {
            properties[key] = value;
        }
    }
    return properties;
}

function readProjectPreset(content: JsonObject): JsonObject | undefined {
    return isJsonObject(content.preset) ? content.preset : undefined;
}

export class WallpaperServer {
    private server: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private pendingServer: PendingServer | null = null;
    private takeoverMonitor: ServerTakeoverMonitor | null = null;
    private ownership: ServerOwnership = 'none';
    private ownerLeaseId = randomUUID();
    private readonly takeoverPollIntervalMs: number;
    private lifecycleGeneration = 0;
    private lifecycleQueue: Promise<void> = Promise.resolve();
    private lifecycleAbortController: AbortController | null = null;
    private readonly scheduleShutdownTask: (task: () => Promise<void>) => void;
    private currentRoot: string = '';
    // 端口必须与 injector.ts 里的保持一致
    private PORT = WALLPAPER_SERVER_PORT; 

    private searchPaths: string[] = [];
    private reloadFlag = false; // [New] Flag to trigger client reload
    private reloadWaiter: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;

    private shutdownTimeout: NodeJS.Timeout | null = null;
    private readonly SHUTDOWN_DELAY = 2 * 60 * 1000; // 2 minutes
    private entryFile: string | null = null;
    private currentLocation: string | undefined;
    private readonly playbackMonitor = new PlaybackMonitor();
    private lastPlaybackLogAt = 0;
    private readonly loggedPlaybackTerminalStates = new Set<'ready' | 'error'>();

    private cssConfig = {
        customCss: '',
        themeCompatibility: false
    };

    public getCurrentInfo() {
        return {
            root: this.currentRoot,
            entry: this.entryFile,
            port: this.PORT,
            ownership: this.ownership,
            instanceId: this.ownerLeaseId
        };
    }

    public getCurrentRoot(): string {
        return this.currentRoot;
    }

    public updateCssConfig(config: { customCss?: string; themeCompatibility?: boolean }) {
        this.cssConfig = {
            customCss: config.customCss ?? this.cssConfig.customCss,
            themeCompatibility: config.themeCompatibility ?? this.cssConfig.themeCompatibility
        };
    }

    constructor(private context: vscode.ExtensionContext, options: WallpaperServerOptions = {}) {
        this.takeoverPollIntervalMs = options.takeoverPollIntervalMs ?? SERVER_TAKEOVER_POLL_INTERVAL_MS;
        this.scheduleShutdownTask = options.scheduleShutdownTask ?? (task => {
            void task();
        });
        // 插件启动时，尝试恢复之前的服务器状态
        const lastPath = this.context.globalState.get<string>('currentWallpaperPath');
        if (lastPath && fs.existsSync(lastPath)) {
            console.log(`[Server] Restoring server for: ${lastPath}`);
            // 获取配置的端口
            const config = vscode.workspace.getConfiguration('vscode-wallpaper-engine');
            const port = config.get<number>('serverPort') || WALLPAPER_SERVER_PORT;
            // this.start(lastPath, port, true); // true 表示这是静默启动，不弹窗
        }
    }

    private resetShutdownTimer() {
        if (this.shutdownTimeout) {
            clearTimeout(this.shutdownTimeout);
        }
        this.shutdownTimeout = setTimeout(() => {
            console.log('[Server] Auto-shutdown due to inactivity.');
            void this.stop().catch(error => {
                console.error('[Server] Auto-shutdown failed:', error);
            });
        }, this.SHUTDOWN_DELAY);
    }

    public triggerReload() {
        this.reloadFlag = true;
    }

    /** 设置刷新标志，并等待壁纸客户端实际取走 205 信号。 */
    public triggerReloadAndWait(timeoutMs = SERVER_PREFLIGHT_TIMEOUT_MS): Promise<void> {
        if (this.reloadWaiter) {
            return Promise.reject(new Error('已有壁纸刷新信号正在等待客户端确认'));
        }
        this.reloadFlag = true;
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.reloadWaiter?.timer !== timer) {
                    return;
                }
                this.reloadWaiter = null;
                this.reloadFlag = false;
                reject(new Error(`壁纸刷新信号确认超时（${timeoutMs} 毫秒）`));
            }, timeoutMs);
            this.reloadWaiter = { resolve, reject, timer };
        });
    }

    private checkServerStatus(port: number, signal?: AbortSignal): Promise<ServerStatusProbe> {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result: ServerStatusProbe) => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve(result);
            };
            const req = http.get(`http://127.0.0.1:${port}/status`, { agent: false, signal }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    finish({ kind: 'occupied' });
                    return;
                }
                let data = '';
                let bytes = 0;
                res.on('data', chunk => {
                    bytes += Buffer.byteLength(chunk);
                    if (bytes > SERVER_STATUS_RESPONSE_LIMIT) {
                        res.destroy();
                        finish({ kind: 'occupied' });
                        return;
                    }
                    data += chunk;
                });
                res.on('end', () => {
                    try {
                        const parsed: unknown = JSON.parse(data);
                        if (isJsonObject(parsed)
                            && parsed.service === WALLPAPER_SERVICE_ID
                            && parsed.protocolVersion === WALLPAPER_SERVICE_PROTOCOL_VERSION
                            && parsed.running === true
                            && typeof parsed.rootPath === 'string'
                            && typeof parsed.instanceId === 'string'
                            && (typeof parsed.entryFile === 'string' || parsed.entryFile === null)) {
                            finish({
                                kind: 'wallpaper',
                                running: true,
                                rootPath: parsed.rootPath,
                                entryFile: parsed.entryFile,
                                instanceId: parsed.instanceId
                            });
                        } else {
                            finish({ kind: 'occupied' });
                        }
                    } catch {
                        finish({ kind: 'occupied' });
                    }
                });
            });
            req.on('error', () => finish({ kind: 'absent' }));
            req.setTimeout(500, () => {
                req.destroy();
                finish({ kind: 'absent' });
            });
        });
    }

    private shutdownRemoteServer(port: number, instanceId: string): Promise<RemoteShutdownResult> {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result: RemoteShutdownResult) => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve(result);
            };
            const req = http.request({
                host: '127.0.0.1',
                port,
                path: '/shutdown',
                method: 'POST',
                agent: false,
                headers: { 'X-Vscode-Wallpaper-Owner': instanceId }
            }, (res) => {
                res.resume();
                finish(res.statusCode === 200
                    ? 'accepted'
                    : res.statusCode === 409
                        ? 'owner-changed'
                        : 'unreachable');
            });
            req.on('error', () => finish('unreachable'));
            req.setTimeout(1000, () => {
                req.destroy();
                finish('unreachable');
            });
            req.end();
        });
    }

    private stopTakeoverMonitor(reportCancellation = true): void {
        this.takeoverMonitor?.stop(reportCancellation);
        this.takeoverMonitor = null;
        if (!this.server) {
            this.ownership = 'none';
        }
    }

    private startFollowingExternalServer(
        rootPath: string,
        port: number,
        entryFile: string | null,
        location: string | undefined,
        ownerInstanceId: string,
        operation: LifecycleOperation
    ): void {
        this.stopTakeoverMonitor(false);
        this.ownership = 'external';
        let observedOwnerId = ownerInstanceId;
        const monitor = new ServerTakeoverMonitor({
            pollIntervalMs: this.takeoverPollIntervalMs,
            probe: async signal => {
                const status = await this.checkServerStatus(port, signal);
                if (status.kind === 'absent') {
                    return 'absent';
                }
                if (status.kind === 'occupied') {
                    return 'occupied';
                }
                if (status.rootPath !== rootPath || status.entryFile !== entryFile) {
                    return 'mismatched';
                }
                observedOwnerId = status.instanceId;
                return 'matching';
            },
            claim: async signal => {
                if (signal.aborted) {
                    return 'contended';
                }
                try {
                    await this.enqueueLifecycle(async () => {
                        if (signal.aborted) {
                            throw new WallpaperServerOperationCancelledError();
                        }
                        await this.startInternal(
                            rootPath,
                            port,
                            entryFile ?? undefined,
                            location,
                            true,
                            'takeover',
                            operation,
                            false
                        );
                    });
                    return 'claimed';
                } catch (error) {
                    if (signal.aborted
                        || operation.signal.aborted
                        || operation.generation !== this.lifecycleGeneration) {
                        return 'contended';
                    }
                    if (this.isAddressInUseError(error)) {
                        return 'contended';
                    }
                    throw error;
                }
            },
            schedule: scheduleTakeoverTask,
            report: (event, error) => this.reportTakeoverEvent(event, port, observedOwnerId, error)
        });
        this.takeoverMonitor = monitor;
        monitor.start();
    }

    private reportTakeoverEvent(
        event: ServerTakeoverEvent,
        port: number,
        ownerInstanceId: string,
        error?: unknown
    ): void {
        const owner = ownerInstanceId.slice(0, 8);
        if (event === 'claim-won') {
            this.ownership = 'local';
        } else if (event === 'superseded' || event === 'terminal-error') {
            this.ownership = 'none';
        }
        const detail = error instanceof Error ? `: ${error.message}` : '';
        console.log(`[Server takeover] ${event} port=${port} owner=${owner}${detail}`);
    }

    private isAddressInUseError(error: unknown): boolean {
        return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
    }

    private beginLifecycleOperation(): LifecycleOperation {
        this.lifecycleAbortController?.abort();
        const controller = new AbortController();
        this.lifecycleAbortController = controller;
        this.lifecycleGeneration += 1;
        return { generation: this.lifecycleGeneration, signal: controller.signal };
    }

    private enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
        const result = this.lifecycleQueue.then(task, task);
        this.lifecycleQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private assertCurrentOperation(operation: LifecycleOperation): void {
        if (operation.signal.aborted || operation.generation !== this.lifecycleGeneration) {
            throw new WallpaperServerOperationCancelledError();
        }
    }

    private waitForLifecycleDelay(delayMs: number, operation: LifecycleOperation): Promise<void> {
        return new Promise((resolve, reject) => {
            if (operation.signal.aborted) {
                reject(new WallpaperServerOperationCancelledError());
                return;
            }
            const finish = () => {
                operation.signal.removeEventListener('abort', abort);
                resolve();
            };
            const timer = setTimeout(finish, delayMs);
            const abort = () => {
                clearTimeout(timer);
                operation.signal.removeEventListener('abort', abort);
                reject(new WallpaperServerOperationCancelledError());
            };
            operation.signal.addEventListener('abort', abort, { once: true });
        });
    }

    private async persistWallpaperState(
        rootPath: string,
        entryFile: string | null,
        location: string | undefined,
        operation: LifecycleOperation
    ): Promise<void> {
        const keys = [
            ['currentWallpaperPath', rootPath],
            ['currentWallpaperEntry', entryFile],
            ['currentWallpaperLocation', location]
        ] as const;
        const previous = keys.map(([key]) => [key, this.context.globalState.get<unknown>(key)] as const);
        let completed = 0;
        try {
            for (const [key, value] of keys) {
                await this.context.globalState.update(key, value);
                completed += 1;
                this.assertCurrentOperation(operation);
            }
        } catch (error) {
            for (let index = completed - 1; index >= 0; index -= 1) {
                const [key, value] = previous[index];
                try {
                    await this.context.globalState.update(key, value);
                } catch (rollbackError) {
                    console.error(`[Server] Failed to roll back persisted state ${key}:`, rollbackError);
                }
            }
            throw error;
        }
    }

    public start(
        rootPath: string,
        port: number,
        entryFile?: string,
        location?: string,
        silent = false,
        allowRemoteHandoff = false
    ): Promise<void> {
        const operation = this.beginLifecycleOperation();
        this.takeoverMonitor?.stop();
        this.takeoverMonitor = null;
        return this.enqueueLifecycle(() => this.startInternal(
            rootPath,
            port,
            entryFile,
            location,
            silent,
            'normal',
            operation,
            allowRemoteHandoff
        ));
    }

    private async startInternal(
        rootPath: string,
        port: number,
        entryFile: string | undefined,
        location: string | undefined,
        silent: boolean,
        mode: 'normal' | 'takeover',
        operation: LifecycleOperation,
        allowRemoteHandoff: boolean
    ): Promise<void> {
        this.assertCurrentOperation(operation);
        if (mode === 'normal') {
            this.stopTakeoverMonitor(false);
        }
        // 每次启动或热切换都必须丢弃旧页面的播放结论。
        if (mode === 'normal') {
            this.playbackMonitor.reset();
            this.lastPlaybackLogAt = 0;
            this.loggedPlaybackTerminalStates.clear();
        }
        console.log(`[server launch] start called. root: ${rootPath}, port: ${port}, entry: ${entryFile}, loc: ${location}`);
        vscode.window.setStatusBarMessage(`Preparing Wallpaper Server...`, 5000);
        
        // 1. Check local instance
        if (this.server && this.PORT === port) {
            this.ownership = 'local';
            if (this.currentRoot === rootPath && this.entryFile === (entryFile ?? null)) {
                return;
            } else {
                console.log(`[Server] Hot swapping root to ${rootPath}`);
                await this.persistWallpaperState(rootPath, entryFile ?? null, location, operation);
                this.assertCurrentOperation(operation);
                this.currentRoot = rootPath;
                this.entryFile = entryFile ?? null;
                this.currentLocation = location;
                this.ownerLeaseId = randomUUID();
                this.updateSearchPaths(rootPath, location);
                this.triggerReload();
                return;
            }
        }

        if (this.server) {
            console.log(`[Server] Port changed from ${this.PORT} to ${port}; rebinding server.`);
            await this.stopLocalResources();
            this.assertCurrentOperation(operation);
            this.ownership = 'none';
        }

        // 2. Check external instance (Multi-window support)
        if (mode === 'normal') {
            const status = await this.checkServerStatus(port, operation.signal);
            this.assertCurrentOperation(operation);
            if (status.kind === 'wallpaper') {
                if (status.rootPath === rootPath && status.entryFile === (entryFile ?? null)) {
                    console.log(`[Server] Reusing existing server for ${rootPath}`);
                    await this.persistWallpaperState(rootPath, entryFile ?? null, location, operation);
                    this.assertCurrentOperation(operation);
                    this.currentRoot = rootPath;
                    this.entryFile = entryFile ?? null;
                    this.currentLocation = location;
                    this.PORT = port;
                    this.updateSearchPaths(rootPath, location);
                    this.startFollowingExternalServer(
                        rootPath,
                        port,
                        this.entryFile,
                        location,
                        status.instanceId,
                        operation
                    );
                    return;
                } else {
                    if (!allowRemoteHandoff) {
                        throw new WallpaperServerConflictError(port);
                    }
                    const observedInstanceId = status.instanceId;
                    console.log(`[Server] Existing server running different path (${status.rootPath}). Restarting...`);
                    const shutdown = await this.shutdownRemoteServer(port, observedInstanceId);
                    this.assertCurrentOperation(operation);
                    if (shutdown !== 'accepted') {
                        throw new WallpaperServerConflictError(port);
                    }
                    console.log('[server launch] Waiting for port release...');
                    let attempts = 0;
                    while (attempts < 20) {
                        await this.waitForLifecycleDelay(500, operation);
                        const currentStatus = await this.checkServerStatus(port, operation.signal);
                        this.assertCurrentOperation(operation);
                        if (currentStatus.kind === 'absent') {
                            console.log('[server launch] Port released.');
                            break;
                        }
                        console.log(`[server launch] Port still busy (attempt ${attempts + 1})...`);
                        if (currentStatus.kind === 'wallpaper'
                            && currentStatus.instanceId === observedInstanceId
                            && attempts % 5 === 0) {
                            const retryShutdown = await this.shutdownRemoteServer(port, observedInstanceId);
                            this.assertCurrentOperation(operation);
                            if (retryShutdown === 'owner-changed') {
                                throw new WallpaperServerConflictError(port);
                            }
                        }
                        attempts += 1;
                    }

                    const finalStatus = await this.checkServerStatus(port, operation.signal);
                    this.assertCurrentOperation(operation);
                    if (finalStatus.kind !== 'absent') {
                        const msg = `Port ${port} is still occupied by another process. Please close other VS Code windows or kill the process manually.`;
                        console.error(`[server launch] ${msg}`);
                        throw new Error(msg);
                    }
                }
            }
        }

        // 关闭旧服务
        await this.stopLocalResources();
        this.assertCurrentOperation(operation);

        const previousMetadata = {
            root: this.currentRoot,
            entry: this.entryFile,
            location: this.currentLocation,
            port: this.PORT,
            searchPaths: [...this.searchPaths],
            ownerLeaseId: this.ownerLeaseId,
            ownership: this.ownership
        };
        this.currentRoot = rootPath;
        this.entryFile = entryFile ?? null;
        this.currentLocation = location;
        this.ownerLeaseId = randomUUID();
        
        this.updateSearchPaths(rootPath, location); // [New] Update search paths on server start
        const restoreMetadata = () => {
            this.currentRoot = previousMetadata.root;
            this.entryFile = previousMetadata.entry;
            this.currentLocation = previousMetadata.location;
            this.PORT = previousMetadata.port;
            this.searchPaths = previousMetadata.searchPaths;
            this.ownerLeaseId = previousMetadata.ownerLeaseId;
            this.ownership = previousMetadata.ownership;
        };

        console.log(`[server launch] Creating HTTP server...`);
        const candidateServer = http.createServer((req, res) => {
            const isHighFrequencyEndpoint = req.url?.startsWith('/media/current')
                || req.url?.startsWith('/playback-event')
                || req.url?.startsWith('/playback-status');
            if (!isHighFrequencyEndpoint) {
                console.log(`[server launch] Request received: ${req.method} ${req.url}`);
            }
            this.resetShutdownTimer(); // Reset timer on every request

            const safeRoot = path.normalize(this.currentRoot);
            // 简单的 URL 处理
            let reqUrl: string;
            try {
                reqUrl = req.url ? decodeURIComponent(req.url.split('?')[0]) : '/';
            } catch {
                res.statusCode = 400;
                res.end('Invalid URL encoding');
                return;
            }
            
            if (!isHighFrequencyEndpoint) {
                console.log(`[Server] Request: ${req.method} ${req.url} -> ${reqUrl}`);
            }

            if (req.method === 'OPTIONS') {
                if (reqUrl === '/shutdown') {
                    res.statusCode = 403;
                    res.end('Cross-origin shutdown is not allowed');
                    return;
                }
                res.setHeader('Access-Control-Allow-Origin', '*');
                const allowedMethods = reqUrl === '/media/current'
                    ? 'GET, HEAD, OPTIONS'
                    : reqUrl === '/playback-event'
                        ? 'POST, OPTIONS'
                        : reqUrl === '/playback-status'
                            ? 'GET, OPTIONS'
                            : 'GET, POST, OPTIONS';
                res.setHeader('Access-Control-Allow-Methods', allowedMethods);
                res.setHeader('Access-Control-Allow-Headers', '*');
                res.statusCode = 204;
                res.end();
                return;
            }

            if (reqUrl === '/media/current') {
                void serveCurrentMedia(req, res, {
                    rootPath: this.currentRoot,
                    location: this.currentLocation,
                    entryFile: this.entryFile
                }).catch(error => {
                    const name = error instanceof Error ? error.name : 'UnknownError';
                    console.error(`[Media] 当前媒体请求处理失败：${name}`);
                    if (!res.headersSent) {
                        res.statusCode = 500;
                        res.end('Media request failed');
                    } else {
                        res.destroy(error instanceof Error ? error : undefined);
                    }
                });
                return;
            }

            if (reqUrl === '/playback-event') {
                void this.handlePlaybackEvent(req, res).catch(error => {
                    const name = error instanceof Error ? error.name : 'UnknownError';
                    console.error(`[Playback] 播放事件处理失败：${name}`);
                    if (!res.headersSent) {
                        res.statusCode = 500;
                        res.end('Playback event failed');
                    }
                });
                return;
            }

            if (reqUrl === '/playback-status') {
                this.handlePlaybackStatus(req, res);
                return;
            }

            // 默认访问 index.html
            if (reqUrl === '/' || reqUrl === '') {
                reqUrl = '/index.html';
            }

            // [Removed] filePath calculation moved to end
            // const filePath = path.join(safeRoot, reqUrl);
            // if (!filePath.startsWith(safeRoot)) { ... }

            // ping，用于检测服务器是否在线，直接返回 200
            if (reqUrl === '/ping') {
                res.setHeader('Access-Control-Allow-Origin', '*');
                if (this.reloadFlag) {
                    console.log('[Server] Sending 205 Reload signal to client');
                    this.reloadFlag = false;
                    res.statusCode = 205; // Reset Content
                    res.end('reload', () => {
                        if (this.reloadWaiter) {
                            clearTimeout(this.reloadWaiter.timer);
                            const waiter = this.reloadWaiter;
                            this.reloadWaiter = null;
                            waiter.resolve();
                        }
                    });
                } else {
                    res.statusCode = 200;
                    res.end('pong');
                }
                return;
            }

            // [New] Status endpoint for multi-instance check
            if (reqUrl === '/status') {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    service: WALLPAPER_SERVICE_ID,
                    protocolVersion: WALLPAPER_SERVICE_PROTOCOL_VERSION,
                    instanceId: this.ownerLeaseId,
                    running: true,
                    rootPath: this.currentRoot,
                    entryFile: this.entryFile
                }));
                return;
            }

            // [New] Shutdown endpoint for multi-instance takeover
            if (reqUrl === '/shutdown') {
                if (req.method !== 'POST') {
                    res.statusCode = 405;
                    res.setHeader('Allow', 'POST');
                    res.end('Method Not Allowed');
                    return;
                }
                const requestedInstanceId = req.headers['x-vscode-wallpaper-owner'];
                const acceptedLeaseId = this.ownerLeaseId;
                const acceptedGeneration = this.lifecycleGeneration;
                if (requestedInstanceId !== acceptedLeaseId) {
                    res.statusCode = 409;
                    res.end('Server owner changed');
                    return;
                }
                res.end('ok', () => {
                    this.scheduleShutdownTask(async () => {
                        if (this.ownerLeaseId !== acceptedLeaseId
                            || this.lifecycleGeneration !== acceptedGeneration) {
                            console.log('[Server] Ignoring stale remote shutdown request.');
                            return;
                        }
                        console.log('[Server] Remote shutdown requested.');
                        try {
                            await this.stop();
                        } catch (error) {
                            console.error('[Server] Remote shutdown failed:', error);
                        }
                    });
                });
                return;
            }

            // [New] Serve Mock API
            if (reqUrl === '/vscode-wallpaper-engine-mock-api.js') {
                res.setHeader('Content-Type', 'application/javascript');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Private-Network', 'true');
                res.end(MOCK_API_SCRIPT);
                return;
            }
            if (reqUrl === '/vscode-wallpaper-engine-bootstrap.js') {
                res.setHeader('Content-Type', 'application/javascript');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Private-Network', 'true');
                res.end(BOOTSTRAP_SCRIPT);
                return;
            }

            // [New] Open Folder
            if (reqUrl === '/open-folder') {
                res.setHeader('Access-Control-Allow-Origin', '*');
                if (this.currentRoot) {
                    // Use vscode.env.openExternal to open the folder
                    vscode.env.openExternal(vscode.Uri.file(this.currentRoot));
                    res.end('ok');
                } else {
                    res.statusCode = 404;
                    res.end('No wallpaper loaded');
                }
                return;
            }

            if (reqUrl === '/config') {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.end(JSON.stringify(this.cssConfig));
                return;
            }

            // 返回由沙箱 iframe 直接加载的壁纸入口 HTML。
            if (reqUrl === '/api/get-entry') {
                console.log(`[Server] /api/get-entry called. entryFile: ${this.entryFile}, root: ${this.currentRoot}`);
                let entryPath = '';
                
                if (this.entryFile) {
                    // If entryFile is provided (Video/Image/Explicit Web)
                    // Check if it's a media file
                    const ext = path.extname(this.entryFile).toLowerCase();
                    if (['.mp4', '.webm', '.mkv', '.avi', '.mov'].includes(ext)) {
                        const html = `
<!DOCTYPE html>
<html>
<head>
    <style>body, html { margin: 0; padding: 0; overflow: hidden; background: black; width: 100%; height: 100%; } video { width: 100%; height: 100%; object-fit: cover; }</style>
</head>
<body>
    <video src="${this.entryFile}" autoplay loop muted playsinline></video>
</body>
</html>`;
                        res.setHeader('Content-Type', 'text/html');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.end(html);
                        return;
                    } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
                        const html = `
<!DOCTYPE html>
<html>
<head>
    <style>body, html { margin: 0; padding: 0; overflow: hidden; background: black; width: 100%; height: 100%; } img { width: 100%; height: 100%; object-fit: cover; }</style>
</head>
<body>
    <img src="${this.entryFile}">
</body>
</html>`;
                        res.setHeader('Content-Type', 'text/html');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.end(html);
                        return;
                    }
                    
                    // If not media, check if it is HTML
                    if (ext === '.html' || ext === '.htm') {
                        // Try to find the file in search paths
                        for (const basePath of this.searchPaths) {
                            const tryPath = path.join(basePath, this.entryFile);
                            if (isPathWithinRealRoot(basePath, tryPath) && fs.statSync(tryPath).isFile()) {
                                entryPath = tryPath;
                                break;
                            }
                        }
                    } else {
                        // If not HTML (e.g. scene.pkg, project.json), try to find index.html in search paths
                        for (const basePath of this.searchPaths) {
                            const tryIndex = path.join(basePath, 'index.html');
                            if (isPathWithinRealRoot(basePath, tryIndex) && fs.statSync(tryIndex).isFile()) {
                                entryPath = tryIndex;
                                break;
                            }
                        }
                        
                        if (!entryPath) {
                            // Fallback to the file itself (might be text/json)
                            const fallbackPath = path.join(this.currentRoot, this.entryFile);
                            if (isPathWithinRealRoot(this.currentRoot, fallbackPath) && fs.statSync(fallbackPath).isFile()) {
                                entryPath = fallbackPath;
                            }
                        }
                    }
                } else {
                    // Fallback: Search for index.html
                    for (const basePath of this.searchPaths) {
                        const tryPath = path.join(basePath, 'index.html');
                        if (isPathWithinRealRoot(basePath, tryPath) && fs.statSync(tryPath).isFile()) {
                            entryPath = tryPath;
                            break;
                        }
                    }
                }

                console.log(`[Server] Resolved entryPath: ${entryPath}`);

                if (!entryPath || !fs.existsSync(entryPath)) {
                    console.log(`[Server] Entry path not found or empty.`);
                    res.statusCode = 404;
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.end('Entry Not Found');
                    return;
                }

                fs.readFile(entryPath, (err, data) => {
                    if (err) {
                        res.statusCode = 404;
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.end('Entry Not Found');
                        return;
                    }
                    let html = data.toString('utf-8');

                    // [Fix] Video playback issue: Convert <video><source src="..."></video> to <video src="..."></video>
                    // Regex explanation:
                    // 1. (<video[^>]*)   : Match opening video tag and attributes
                    // 2. (>[\s\S]*?)     : Match content between video tag and source tag (non-greedy)
                    // 3. <source[^>]*\s+src=['"]([^'"]+)['"][^>]*> : Match source tag and capture src URL
                    // 4. ([\s\S]*?<\/video>) : Match remaining content and closing video tag
                    html = html.replace(/(<video[^>]*)(>[\s\S]*?)<source[^>]*\s+src=['"]([^'"]+)['"][^>]*>([\s\S]*?<\/video>)/gi, '$1 src="$3"$2$4');

                    const baseTag = /<base\b/i.test(html) ? '' : `<base href="http://127.0.0.1:${this.PORT}/" />`;
                    const injection = `
${baseTag}
<style>
    /* Hide common debug elements (stats.js, dat.gui, etc) */
    #stats, .stats, #fps, .fps, #debug, .debug, .dg.ac { display: none !important; }
</style>
<script src="/vscode-wallpaper-engine-mock-api.js"></script>
<script src="/vscode-wallpaper-engine-bootstrap.js"></script>
`;
                    if (html.includes('<head>')) {
                        html = html.replace('<head>', '<head>' + injection);
                    } else if (html.includes('<body>')) {
                        html = html.replace('<body>', '<body>' + injection);
                    } else {
                        html = injection + html;
                    }
                    res.setHeader('Content-Type', 'text/html');
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.end(html);
                });
                return;
            }

            // [New] API: readdir
            if (reqUrl === '/api/readdir') {
                const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
                let targetPath = urlObj.searchParams.get("path");
                if (targetPath) {
                    targetPath = targetPath.replace(/^[\\/]+/, ""); // Remove leading slashes
                    

                    // Search in all paths
                    let allFiles = new Set<string>();
                    for (const basePath of this.searchPaths) {
                        const fullPath = path.join(basePath, targetPath);
                        if (isPathWithinRealRoot(basePath, fullPath) && fs.existsSync(fullPath)) {
                            try {
                                if (fs.statSync(fullPath).isDirectory()) {
                                    const files = fs.readdirSync(fullPath);
                                    files.forEach(f => allFiles.add(f));
                                }
                            } catch (e) {}
                        }
                    }
                    
                    if (allFiles.size > 0) {
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.end(JSON.stringify(Array.from(allFiles)));
                        return;
                    }
                }
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.end('[]');
                return;
            }

            // [New] API: random-file
            if (reqUrl === '/api/random-file') {
                console.log(`[Server] Handling random-file request`);
                const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
                const propName = urlObj.searchParams.get("prop");
                
                // 1. Read project.json (merged)
                const finalProps: ProjectProperties = {};
                for (let i = this.searchPaths.length - 1; i >= 0; i--) {
                    const pPath = path.join(this.searchPaths[i], "project.json");
                    if (fs.existsSync(pPath)) {
                        try {
                            const content = readProjectJson(pPath);
                            if (!content) {
                                continue;
                            }
                            const props = readProjectProperties(content);
                            Object.assign(finalProps, props);
                            const preset = readProjectPreset(content);
                            if (preset) {
                                Object.keys(preset).forEach((key: string) => {
                                    if (finalProps[key]) {
                                        finalProps[key].value = preset[key];
                                    }
                                });
                            }
                        } catch (e) {}
                    }
                }

                let targetPath: string | null = null;
                let prop: JsonObject | undefined = finalProps[propName || ''];
                if (!prop && propName) {
                    const key = Object.keys(finalProps).find(k => k.toLowerCase() === propName.toLowerCase());
                    if (key) { prop = finalProps[key]; }
                }
                
                if (prop) {
                    const candidate = prop.value ?? prop.default;
                    if (typeof candidate === 'string') {
                        targetPath = candidate;
                    }
                }

                let fileUrl = null;
                if (targetPath) {
                    targetPath = targetPath.replace(/^[\\/]+/, "");
                    
                    // Find files in all search paths
                    let allFiles: string[] = [];
                    for (const basePath of this.searchPaths) {
                        const fullPath = path.join(basePath, targetPath);
                        if (isPathWithinRealRoot(basePath, fullPath) && fs.existsSync(fullPath)) {
                            try {
                                if (fs.statSync(fullPath).isDirectory()) {
                                    const files = fs.readdirSync(fullPath);
                                    const validFiles = files.filter(f => /\.(jpg|jpeg|png|gif|webm|mp4)$/i.test(f));
                                    allFiles = allFiles.concat(validFiles);
                                }
                            } catch (e) {}
                        }
                    }

                    if (allFiles.length > 0) {
                        const randomFile = allFiles[Math.floor(Math.random() * allFiles.length)];
                        fileUrl = `http://127.0.0.1:${this.PORT}/${targetPath}/${randomFile}`;
                    }
                }
                
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.end(JSON.stringify({ file: fileUrl }));
                return;
            }

            // [New] API: Proxy
            if (reqUrl === '/proxy') {
                let targetUrl: string | null;
                try {
                    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
                    targetUrl = urlObj.searchParams.get('url');
                } catch {
                    res.statusCode = 400;
                    res.end('Invalid proxy URL');
                    return;
                }
                if (!targetUrl) {
                    res.statusCode = 400;
                    res.end('Missing url param');
                    return;
                }
                let target: URL;
                try {
                    target = validateProxyTarget(targetUrl);
                } catch {
                    res.statusCode = 400;
                    res.end('Proxy target is not allowed');
                    return;
                }
                dns.lookup(target.hostname, { all: true }, (lookupError, addresses) => {
                    if (lookupError || addresses.length === 0) {
                        res.statusCode = 502;
                        res.end('Proxy DNS lookup failed');
                        return;
                    }
                    try {
                        addresses.forEach(({ address }) => assertPublicAddress(address));
                    } catch {
                        res.statusCode = 400;
                        res.end('Proxy target is not allowed');
                        return;
                    }
                    const address = addresses[0];
                    const client = target.protocol === 'https:' ? https : http;
                    const proxyReq = client.get({
                        protocol: target.protocol,
                        hostname: address.address,
                        port: target.port || undefined,
                        path: `${target.pathname}${target.search}`,
                        headers: { Host: target.host },
                        servername: target.hostname
                    }, proxyRes => {
                        if ((proxyRes.statusCode || 0) >= 300 && (proxyRes.statusCode || 0) < 400) {
                            proxyRes.resume();
                            res.statusCode = 502;
                            res.end('Proxy redirects are not allowed');
                            return;
                        }
                        const maxBytes = 10 * 1024 * 1024;
                        const contentLength = Number(proxyRes.headers['content-length'] || 0);
                        if (contentLength > maxBytes) {
                            proxyRes.resume();
                            res.statusCode = 502;
                            res.end('Proxy response too large');
                            return;
                        }
                        const headers = { ...proxyRes.headers, 'access-control-allow-origin': '*' };
                        delete headers['access-control-allow-methods'];
                        delete headers['access-control-allow-headers'];
                        delete headers['access-control-allow-credentials'];
                        const chunks: Buffer[] = [];
                        let total = 0;
                        let exceededLimit = false;
                        proxyRes.on('data', chunk => {
                            total += Buffer.byteLength(chunk);
                            if (total > maxBytes) {
                                exceededLimit = true;
                                proxyRes.resume();
                                return;
                            }
                            chunks.push(Buffer.from(chunk));
                        });
                        proxyRes.on('end', () => {
                            if (exceededLimit) {
                                res.statusCode = 502;
                                res.end('Proxy response too large');
                                return;
                            }
                            res.writeHead(proxyRes.statusCode || 200, headers);
                            res.end(Buffer.concat(chunks));
                        });
                    });
                    proxyReq.setTimeout(10000, () => proxyReq.destroy(new Error('Proxy timeout')));
                    proxyReq.on('error', error => {
                        console.error(`[Proxy Error] ${error.message}`);
                        if (!res.headersSent) {
                            res.statusCode = 502;
                            res.end('Proxy request failed');
                        }
                    });
                });
                return;
            }

            // [New] API: Serve processed project.json (with presets applied)
            if (reqUrl === '/project.json') {
                const finalProject: JsonObject = {};
                const finalProps: ProjectProperties = {};
                
                // Merge from dependencies (reverse order)
                for (let i = this.searchPaths.length - 1; i >= 0; i--) {
                    const pPath = path.join(this.searchPaths[i], "project.json");
                    if (fs.existsSync(pPath)) {
                        try {
                            console.log(`[add set] Parsing project.json at ${pPath}`);
                            const content = readProjectJson(pPath);
                            if (!content) {
                                continue;
                            }
                            console.log(`[add set] Merging content from ${pPath}`);
                            Object.assign(finalProject, content);
                            
                            const props = readProjectProperties(content);
                            console.log(`[add set] Found properties: ${Object.keys(props).map(k => `${k}=${props[k].value ?? props[k].default}`).join(', ')}`);
                            Object.assign(finalProps, props);
                            
                            const preset = readProjectPreset(content);
                            if (preset) {
                                console.log(`[add set] Found presets: ${Object.keys(preset).join(', ')}`);
                                Object.keys(preset).forEach((key: string) => {
                                    if (finalProps[key]) {
                                        console.log(`[add set] Applying preset for ${key}: ${preset[key]}`);
                                        finalProps[key].value = preset[key];
                                        finalProps[key].default = preset[key];
                                    }
                                });
                            }
                        } catch (e) {
                            console.log(`[add set] Error parsing ${pPath}: ${e}`);
                        }
                    }
                }
                
                const general = isJsonObject(finalProject.general) ? finalProject.general : {};
                general.properties = finalProps;
                finalProject.general = general;
                
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.end(JSON.stringify(finalProject));
                return;
            }

            // [Modified] File Serving with Search Paths
            let filePath = '';
            let fileFound = false;
            
            console.log(`[add file] Request: ${reqUrl}`);
            
            for (const basePath of this.searchPaths) {
                const tryPath = path.join(basePath, reqUrl);
                if (isPathWithinRealRoot(basePath, tryPath) && fs.existsSync(tryPath) && fs.statSync(tryPath).isFile()) {
                    filePath = tryPath;
                    fileFound = true;
                    console.log(`[add file] Serving: ${filePath}`);
                    break;
                }
            }

            if (fileFound) {
                fs.readFile(filePath, (err, data) => {
                    if (err) {
                        res.statusCode = 500;
                        res.end('Error reading file');
                        return;
                    }

                    const ext = path.extname(filePath).toLowerCase();
                    const mimeType = this.getMimeType(ext);
                    res.setHeader('Content-Type', mimeType);
                    res.setHeader('Access-Control-Allow-Origin', '*'); // 允许跨域
                    res.setHeader('Access-Control-Allow-Private-Network', 'true');

                    // [New] Inject scripts into HTML
                    if (ext === '.html') {
                        let html = data.toString('utf-8');
                        const injection = `
<script src="/vscode-wallpaper-engine-mock-api.js"></script>
<script src="/vscode-wallpaper-engine-bootstrap.js"></script>
`;
                        if (html.includes('<head>')) {
                            html = html.replace('<head>', '<head>' + injection);
                        } else if (html.includes('<body>')) {
                            html = html.replace('<body>', '<body>' + injection);
                        } else {
                            html = injection + html;
                        }
                        res.end(html);
                    } 
                    // [New] Patch JS files to fix file:/// issue (copied from demo)
                    else if (ext === '.js') {
                        let content = data.toString('utf-8');
                        if (content.includes('var path = "file:///" + filePath;')) {
                            console.log(`[Server] Patching file:/// issue in ${path.basename(filePath)}`);
                            content = content.replace(
                                'var path = "file:///" + filePath;',
                                'var path = (filePath.indexOf("http")===0 ? "" : "file:///") + filePath;'
                            );
                            res.end(content);
                        } else {
                            res.end(data);
                        }
                    }
                    else {
                        res.end(data);
                    }
                });
                return;
            } else {
                console.warn(`[Server 404] ${reqUrl}`);
                console.log(`[add file] Not Found: ${reqUrl} in paths: ${JSON.stringify(this.searchPaths)}`);
                res.statusCode = 404;
                res.end('Not Found');
            }

        });

        this.pendingServer = { generation: operation.generation, server: candidateServer, wss: null };

        // Initialize WebSocket Server
        let candidateWss: WebSocketServer | null = null;
        try {
            console.log(`[Server] Initializing WebSocket Server`);
            candidateWss = new WebSocketServer({ noServer: true });
            this.pendingServer.wss = candidateWss;
            
            candidateServer.on('upgrade', (request, socket, head) => {
                candidateWss?.handleUpgrade(request, socket, head, (ws) => {
                    candidateWss?.emit('connection', ws, request);
                });
            });

            candidateWss.on('connection', (ws) => {
                console.log('[Server] WebSocket connected');
                ws.on('message', (message) => {
                    // Optional: Handle messages from clients
                });
            });
        } catch (error) {
            console.error('[Server] Failed to initialize WebSocket Server:', error);
            await this.discardPendingServer(operation.generation, candidateServer, candidateWss);
            restoreMetadata();
            if (mode === 'normal') {
                this.ownership = 'none';
            }
            throw error;
        }
        
        console.log(`[server launch] Setting up server listeners`);
        const pendingListenController = new AbortController();
        const abortPendingListen = () => pendingListenController.abort();
        operation.signal.addEventListener('abort', abortPendingListen, { once: true });
        try {
            const listening = waitForServerListening(candidateServer, SERVER_STARTUP_TIMEOUT_MS);
            try {
                candidateServer.listen({ port, host: '127.0.0.1', signal: pendingListenController.signal });
            } catch (error) {
                candidateServer.emit('error', error instanceof Error ? error : new Error(String(error)));
            }
            await listening;
            this.assertCurrentOperation(operation);
            const address = candidateServer.address();
            if (address && typeof address !== 'string') {
                port = address.port;
            }
        } catch (error) {
            console.error('[server launch] Server failed to listen:', error);
            await this.discardPendingServer(operation.generation, candidateServer, candidateWss);
            restoreMetadata();
            if (mode === 'normal') {
                this.ownership = 'none';
            }
            throw error;
        } finally {
            operation.signal.removeEventListener('abort', abortPendingListen);
        }

        try {
            await this.persistWallpaperState(rootPath, this.entryFile, location, operation);
            this.assertCurrentOperation(operation);
        } catch (error) {
            await this.discardPendingServer(operation.generation, candidateServer, candidateWss);
            restoreMetadata();
            throw error;
        }

        this.pendingServer = null;
        this.server = candidateServer;
        this.wss = candidateWss;
        this.PORT = port;
        this.ownership = 'local';
        this.resetShutdownTimer();
        console.log(`[server launch] Wallpaper Server started on port ${this.PORT}${silent ? ' (silent)' : ''}`);
    }

    public async verifyHealth(
        timeoutMs = SERVER_PREFLIGHT_TIMEOUT_MS,
        expected?: { rootPath: string; entryFile: string }
    ): Promise<void> {
        let response;
        try {
            response = await requestLocalEndpoint(this.PORT, '/status', timeoutMs);
        } catch (error) {
            throw new WallpaperPreflightError('health', '壁纸服务器健康检查失败', { cause: error });
        }
        if (response.statusCode !== 200) {
            throw new WallpaperPreflightError('health', `壁纸服务器健康检查返回 HTTP ${response.statusCode}`);
        }
        try {
            const status = JSON.parse(response.body) as {
                service?: string;
                protocolVersion?: number;
                instanceId?: string;
                running?: boolean;
                rootPath?: string;
                entryFile?: string | null;
            };
            if (status.service !== WALLPAPER_SERVICE_ID
                || status.protocolVersion !== WALLPAPER_SERVICE_PROTOCOL_VERSION
                || typeof status.instanceId !== 'string'
                || status.running !== true) {
                throw new Error('服务身份或 running 状态无效');
            }
            if (expected) {
                if (path.resolve(status.rootPath || '') !== path.resolve(expected.rootPath)) {
                    throw new Error('rootPath 与待确认壁纸不一致');
                }
                if ((status.entryFile || '') !== expected.entryFile) {
                    throw new Error('entryFile 与待确认壁纸不一致');
                }
            }
        } catch (error) {
            throw new WallpaperPreflightError('health', '壁纸服务器健康检查响应无效', { cause: error });
        }
        console.log(`[Server Preflight] Health check passed on port ${this.PORT}`);
    }

    public async verifyEntry(timeoutMs = SERVER_PREFLIGHT_TIMEOUT_MS): Promise<void> {
        let response;
        try {
            response = await requestLocalEndpoint(this.PORT, '/api/get-entry', timeoutMs);
        } catch (error) {
            throw new WallpaperPreflightError('entry', '壁纸入口检查失败', { cause: error });
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new WallpaperPreflightError('entry', `壁纸入口返回 HTTP ${response.statusCode}`);
        }
        if (!response.contentType.toLowerCase().startsWith('text/html')) {
            throw new WallpaperPreflightError('entry', `壁纸入口内容类型无效: ${response.contentType || '缺失'}`);
        }
        console.log(`[Server Preflight] Entry check passed on port ${this.PORT}`);
    }

    /** 等待 Workbench 回报真实播放就绪，而不是只确认媒体文件存在。 */
    public async verifyPlaybackReady(
        expectedMediaType: PlaybackMediaType,
        timeoutMs = PLAYBACK_READY_TIMEOUT_MS
    ): Promise<void> {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new Error('播放就绪超时时间必须大于 0');
        }
        const deadline = Date.now() + timeoutMs;
        let lastRequestError: Error | undefined;

        while (Date.now() < deadline) {
            const remaining = Math.max(deadline - Date.now(), 1);
            try {
                const response = await requestLocalEndpoint(
                    this.PORT,
                    '/playback-status',
                    Math.min(remaining, 1000)
                );
                if (response.statusCode !== 200) {
                    throw new Error(`播放状态端点返回 HTTP ${response.statusCode}`);
                }
                if (!response.contentType.toLowerCase().startsWith('application/json')) {
                    throw new Error('播放状态端点内容类型无效');
                }
                if (Buffer.byteLength(response.body) > PLAYBACK_STATUS_RESPONSE_LIMIT) {
                    throw new Error('播放状态响应过大');
                }

                let parsed: unknown;
                try {
                    parsed = JSON.parse(response.body);
                } catch {
                    throw new Error('播放状态响应不是有效 JSON');
                }
                const status = parsePlaybackStatus(parsed);
                if (!status) {
                    throw new Error('播放状态响应字段无效');
                }
                lastRequestError = undefined;
                if (status.state !== 'idle' && status.mediaType === expectedMediaType) {
                    if (status.state === 'ready') {
                        console.log(`[Playback] ${expectedMediaType} 已确认播放就绪`);
                        return;
                    }
                    if (status.state === 'error') {
                        throw new Error(
                            `媒体播放失败（${status.event}${status.errorCode === undefined ? '' : `，错误码 ${status.errorCode}`}）`
                        );
                    }
                }
            } catch (error) {
                const normalized = error instanceof Error ? error : new Error(String(error));
                if (normalized.message.startsWith('媒体播放失败')) {
                    throw normalized;
                }
                lastRequestError = normalized;
            }

            const delay = Math.min(PLAYBACK_STATUS_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0));
            if (delay > 0) {
                await new Promise<void>(resolve => setTimeout(resolve, delay));
            }
        }

        const suffix = lastRequestError ? `；最后错误：${lastRequestError.message}` : '';
        throw new Error(`等待 ${expectedMediaType} 播放就绪超时（${timeoutMs} 毫秒）${suffix}`);
    }

    private async handlePlaybackEvent(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        if (request.method !== 'POST') {
            response.statusCode = 405;
            response.setHeader('Allow', 'POST');
            response.end('Method Not Allowed');
            return;
        }

        const body = await readBoundedBody(request, PLAYBACK_EVENT_BODY_LIMIT);
        if (body.kind === 'too-large') {
            response.statusCode = 413;
            response.end('Playback event too large');
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(body.body);
        } catch {
            response.statusCode = 400;
            response.end('Invalid playback event');
            return;
        }
        const report = parsePlaybackReport(parsed);
        if (!report) {
            response.statusCode = 400;
            response.end('Invalid playback event');
            return;
        }

        const snapshot = this.playbackMonitor.update(report);
        const now = Date.now();
        const terminalState = snapshot.state === 'ready' || snapshot.state === 'error'
            ? snapshot.state
            : undefined;
        const shouldLogTerminal = terminalState !== undefined
            && !this.loggedPlaybackTerminalStates.has(terminalState);
        if (shouldLogTerminal || terminalState === undefined && now - this.lastPlaybackLogAt >= 1000) {
            this.lastPlaybackLogAt = now;
            if (terminalState !== undefined) {
                this.loggedPlaybackTerminalStates.add(terminalState);
            }
            console.log(
                `[Playback] state=${snapshot.state} media=${snapshot.mediaType} event=${snapshot.event}`
                + `${snapshot.errorCode === undefined ? '' : ` errorCode=${snapshot.errorCode}`}`
            );
        }
        response.statusCode = 204;
        response.end();
    }

    private handlePlaybackStatus(request: http.IncomingMessage, response: http.ServerResponse): void {
        if (request.method !== 'GET') {
            response.statusCode = 405;
            response.setHeader('Allow', 'GET');
            response.end('Method Not Allowed');
            return;
        }
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(JSON.stringify(this.playbackMonitor.current() ?? { state: 'idle' }));
    }

    private updateSearchPaths(rootPath: string, location?: string) {
        console.log(`[add file] Updating search paths for root: ${rootPath}, location: ${location}`);
        this.searchPaths = [rootPath];
        if (location && location !== rootPath) {
            this.searchPaths.push(location);
        }
        
        const basePath = path.dirname(rootPath);
        console.log(`[add file] Inferred dependency base path: ${basePath}`);

        // Try to find dependencies if it looks like a workshop ID
        const match = rootPath.match(/[\\/](\d+)$/);
        if (match) {
            const currentId = match[1];
            
            const visited = new Set([currentId]);
            const queue = [currentId];
            
            while (queue.length > 0) {
                const currId = queue.shift();
                if (!currId) { continue; }

                let currPath = rootPath;
                if (currId !== currentId) {
                    currPath = path.join(basePath, currId);
                }
                
                console.log(`[add file] Checking dependency: ${currId} at ${currPath}`);
                const projPath = path.join(currPath, "project.json");
                if (fs.existsSync(projPath)) {
                    try {
                        const proj = readProjectJson(projPath);
                        if (!proj) {
                            continue;
                        }
                        let deps: string[] = [];
                        if (typeof proj.dependency === "string") {
                            deps = [proj.dependency];
                        } else if (Array.isArray(proj.dependency)
                            && proj.dependency.every((dependency): dependency is string => typeof dependency === 'string')) {
                            deps = proj.dependency;
                        }
                        
                        if (deps.length > 0) {
                            console.log(`[add file] Found dependencies in ${currId}: ${deps.join(', ')}`);
                        }
                        
                        for (const depId of deps) {
                            if (!visited.has(depId)) {
                                visited.add(depId);
                                queue.push(depId);
                                const depPath = path.join(basePath, depId);
                                if (fs.existsSync(depPath)) {
                                    this.searchPaths.push(depPath);
                                    console.log(`[Server] Added dependency: ${depId}`);
                                    console.log(`[add file] Found dependency path: ${depPath}`);
                                } else {
                                    console.log(`[add file] Dependency path not found: ${depPath}`);
                                }
                            }
                        }
                    } catch (e) {
                        console.log(`[add file] Error reading project.json at ${projPath}: ${e}`);
                    }
                } else {
                    console.log(`[add file] project.json not found at ${projPath}`);
                }
            }
        }
        console.log(`[add file] Final searchPaths: ${JSON.stringify(this.searchPaths)}`);
    }

    public stop(): Promise<void> {
        this.beginLifecycleOperation();
        this.takeoverMonitor?.stop();
        this.takeoverMonitor = null;
        return this.enqueueLifecycle(async () => {
            this.ownership = 'none';
            await this.stopLocalResources();
        });
    }

    private async discardPendingServer(
        generation: number,
        server: http.Server,
        wss: WebSocketServer | null
    ): Promise<void> {
        if (this.pendingServer?.generation === generation && this.pendingServer.server === server) {
            this.pendingServer = null;
        }
        await this.closeServerResources(server, wss);
    }

    private async closeServerResources(server: http.Server, wss: WebSocketServer | null): Promise<void> {
        await this.closeWebSocketResources(wss);
        if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }
        await new Promise<void>((resolve, reject) => {
            if (!server.listening) {
                resolve();
                return;
            }
            server.close(error => error ? reject(error) : resolve());
        });
    }

    private async closeWebSocketResources(wss: WebSocketServer | null): Promise<void> {
        if (!wss) {
            return;
        }
        for (const client of wss.clients) {
            client.terminate();
        }
        await new Promise<void>(resolve => {
            try {
                wss.close(() => resolve());
            } catch (error) {
                console.error('[Server] Failed to close WebSocket server:', error);
                resolve();
            }
        });
    }

    private async stopLocalResources(): Promise<void> {
        if (this.shutdownTimeout) {
            clearTimeout(this.shutdownTimeout);
            this.shutdownTimeout = null;
        }
        if (this.pendingServer) {
            const pending = this.pendingServer;
            this.pendingServer = null;
            await this.closeServerResources(pending.server, pending.wss);
        }
        if (this.server) {
            const activeServer = this.server;
            const activeWss = this.wss;
            this.server = null;
            this.wss = null;
            await this.closeServerResources(activeServer, activeWss);
        } else if (this.wss) {
            const orphanedWss = this.wss;
            this.wss = null;
            await this.closeWebSocketResources(orphanedWss);
        }
        if (this.reloadWaiter) {
            clearTimeout(this.reloadWaiter.timer);
            const waiter = this.reloadWaiter;
            this.reloadWaiter = null;
            this.reloadFlag = false;
            waiter.reject(new Error('壁纸服务器已停止，刷新信号未被客户端确认'));
        }
        console.log('[Server] Server stopped.');
    }

    /**
     * 清除用于启动恢复的扩展状态，但不停止当前服务。
     *
     * `stop()` 有意保留这些值，便于普通服务重启；显式还原流程应在
     * 停止服务后调用本方法，避免 VS Code 重载时依据旧状态恢复壁纸。
     */
    public async clearPersistedWallpaperState(): Promise<void> {
        const failures: Array<{ key: string; error: unknown }> = [];
        for (const key of PERSISTED_WALLPAPER_STATE_KEYS) {
            try {
                await this.context.globalState.update(key, undefined);
            } catch (error) {
                failures.push({ key, error });
                console.error(`[Server] Failed to clear persisted state ${key}:`, error);
            }
        }
        if (failures.length > 0) {
            throw new PersistedWallpaperStateError(failures);
        }
        console.log('[Server] Persisted wallpaper state cleared.');
    }

    public broadcast(data: JsonValue) {
        if (this.wss) {
            const msg = JSON.stringify(data);
            this.wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(msg);
                }
            });
        }
    }

    private getMimeType(ext: string): string {
        const map: { [key: string]: string } = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.wav': 'audio/wav',
            '.mp3': 'audio/mpeg',
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.wasm': 'application/wasm',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.frag': 'text/plain',
            '.vert': 'text/plain',
            '.glsl': 'text/plain',
        };
        return map[ext] || 'application/octet-stream';
    }
}
