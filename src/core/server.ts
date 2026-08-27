import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import * as fs from 'fs';
import * as path from 'path';
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

export { validateWallpaperMedia, waitForServerListening, WallpaperServerStartupTimeoutError } from './server-preflight';

const SERVER_STARTUP_TIMEOUT_MS = 5000;
const SERVER_PREFLIGHT_TIMEOUT_MS = 3000;

export class WallpaperServer {
    private server: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private currentRoot: string = '';
    // 端口必须与 injector.ts 里的保持一致
    private PORT = WALLPAPER_SERVER_PORT; 

    private searchPaths: string[] = [];
    private reloadFlag = false; // [New] Flag to trigger client reload

    private shutdownTimeout: NodeJS.Timeout | null = null;
    private readonly SHUTDOWN_DELAY = 2 * 60 * 1000; // 2 minutes
    private entryFile: string | null = null;
    private currentLocation: string | undefined;

    private cssConfig = {
        customCss: ''
    };

    public getCurrentInfo() {
        return {
            root: this.currentRoot,
            entry: this.entryFile,
            port: this.PORT
        };
    }

    public getCurrentRoot(): string {
        return this.currentRoot;
    }

    public updateCssConfig(config: { customCss: string }) {
        this.cssConfig = config;
    }

    constructor(private context: vscode.ExtensionContext) {
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
            this.stop();
        }, this.SHUTDOWN_DELAY);
    }

    public triggerReload() {
        this.reloadFlag = true;
    }

    private checkServerStatus(port: number): Promise<{ running: boolean, rootPath: string, entryFile?: string | null } | null> {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/status`, { agent: false }, (res) => {
                if (res.statusCode !== 200) {
                    resolve(null);
                    return;
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(500, () => {
                req.destroy();
                resolve(null);
            });
        });
    }

    private shutdownRemoteServer(port: number): Promise<void> {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/shutdown`, { agent: false }, (res) => {
                resolve();
            });
            req.on('error', () => resolve());
            req.setTimeout(1000, () => {
                req.destroy();
                resolve();
            });
        });
    }

    public async start(rootPath: string, port: number, entryFile?: string, location?: string, silent = false): Promise<void> {
        console.log(`[server launch] start called. root: ${rootPath}, port: ${port}, entry: ${entryFile}, loc: ${location}`);
        vscode.window.setStatusBarMessage(`Preparing Wallpaper Server...`, 5000);
        
        // 1. Check local instance
        if (this.server && this.PORT === port) {
            if (this.currentRoot === rootPath && this.entryFile === (entryFile || null)) {
                return;
            } else {
                console.log(`[Server] Hot swapping root to ${rootPath}`);
                this.currentRoot = rootPath;
                this.entryFile = entryFile || null;
                this.currentLocation = location;
                await this.context.globalState.update('currentWallpaperPath', rootPath);
                await this.context.globalState.update('currentWallpaperEntry', this.entryFile);
                await this.context.globalState.update('currentWallpaperLocation', location);
                this.updateSearchPaths(rootPath, location);
                this.triggerReload();
                return;
            }
        }

        if (this.server) {
            console.log(`[Server] Port changed from ${this.PORT} to ${port}; rebinding server.`);
            await this.stop();
        }
        this.PORT = port;

        // 2. Check external instance (Multi-window support)
        const status = await this.checkServerStatus(port);
        if (status && status.running) {
            if (status.rootPath === rootPath && status.entryFile === (entryFile || null)) {
                console.log(`[Server] Reusing existing server for ${rootPath}`);
                this.currentRoot = rootPath;
                this.entryFile = entryFile || null;
                this.currentLocation = location;
                this.updateSearchPaths(rootPath, location);
                await this.context.globalState.update('currentWallpaperPath', rootPath);
                await this.context.globalState.update('currentWallpaperEntry', this.entryFile);
                await this.context.globalState.update('currentWallpaperLocation', location);
                return;
            } else {
                console.log(`[Server] Existing server running different path (${status.rootPath}). Restarting...`);
                await this.shutdownRemoteServer(port);
                // Wait for port to be released
                console.log('[server launch] Waiting for port release...');
                let attempts = 0;
                while (attempts < 20) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    const s = await this.checkServerStatus(port);
                    if (!s) {
                        console.log('[server launch] Port released.');
                        break;
                    }
                    console.log(`[server launch] Port still busy (attempt ${attempts + 1})...`);
                    // Try to shutdown again periodically
                    if (attempts % 5 === 0) {
                        await this.shutdownRemoteServer(port);
                    }
                    attempts++;
                }
                
                // Final check
                const finalStatus = await this.checkServerStatus(port);
                if (finalStatus && finalStatus.running) {
                    const msg = `Port ${port} is still occupied by another process. Please close other VS Code windows or kill the process manually.`;
                    console.error(`[server launch] ${msg}`);
                    throw new Error(msg);
                }
            }
        }

        // 关闭旧服务
        await this.stop();

        this.currentRoot = rootPath;
        this.entryFile = entryFile || null;
        this.currentLocation = location;
        
        this.updateSearchPaths(rootPath, location); // [New] Update search paths on server start

        console.log(`[server launch] Creating HTTP server...`);
        this.server = http.createServer((req, res) => {
            console.log(`[server launch] Request received: ${req.method} ${req.url}`);
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
            
            console.log(`[Server] Request: ${req.method} ${req.url} -> ${reqUrl}`);

            if (req.method === 'OPTIONS') {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', '*');
                res.statusCode = 204;
                res.end();
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
                    res.end('reload');
                } else {
                    res.statusCode = 200;
                    res.end('pong');
                }
                return;
            }

            // [New] Status endpoint for multi-instance check
            if (reqUrl === '/status') {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.end(JSON.stringify({
                    running: true,
                    rootPath: this.currentRoot,
                    entryFile: this.entryFile
                }));
                return;
            }

            // [New] Shutdown endpoint for multi-instance takeover
            if (reqUrl === '/shutdown') {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.end('ok');
                setTimeout(() => {
                    console.log('[Server] Remote shutdown requested.');
                    this.stop();
                }, 100);
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
                let finalProps: any = {};
                for (let i = this.searchPaths.length - 1; i >= 0; i--) {
                    const pPath = path.join(this.searchPaths[i], "project.json");
                    if (fs.existsSync(pPath)) {
                        try {
                            const content = JSON.parse(fs.readFileSync(pPath, "utf-8"));
                            const props = content.properties || (content.general && content.general.properties) || {};
                            Object.assign(finalProps, props);
                            if (content.preset) {
                                Object.keys(content.preset).forEach((key: string) => {
                                    if (finalProps[key]) {
                                        finalProps[key].value = content.preset[key];
                                    }
                                });
                            }
                        } catch (e) {}
                    }
                }

                let targetPath: string | null = null;
                let prop = finalProps[propName || ''];
                if (!prop && propName) {
                    const key = Object.keys(finalProps).find(k => k.toLowerCase() === propName.toLowerCase());
                    if (key) { prop = finalProps[key]; }
                }
                
                if (prop) {
                    targetPath = prop.value || prop.default;
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
                let finalProject: any = {};
                let finalProps: any = {};
                
                // Merge from dependencies (reverse order)
                for (let i = this.searchPaths.length - 1; i >= 0; i--) {
                    const pPath = path.join(this.searchPaths[i], "project.json");
                    if (fs.existsSync(pPath)) {
                        try {
                            console.log(`[add set] Parsing project.json at ${pPath}`);
                            const content = JSON.parse(fs.readFileSync(pPath, "utf-8"));
                            console.log(`[add set] Merging content from ${pPath}`);
                            Object.assign(finalProject, content);
                            
                            const props = content.properties || (content.general && content.general.properties) || {};
                            console.log(`[add set] Found properties: ${Object.keys(props).map(k => `${k}=${props[k].value ?? props[k].default}`).join(', ')}`);
                            Object.assign(finalProps, props);
                            
                            if (content.preset) {
                                console.log(`[add set] Found presets: ${Object.keys(content.preset).join(', ')}`);
                                Object.keys(content.preset).forEach((key: string) => {
                                    if (finalProps[key]) {
                                        console.log(`[add set] Applying preset for ${key}: ${content.preset[key]}`);
                                        finalProps[key].value = content.preset[key];
                                        finalProps[key].default = content.preset[key];
                                    }
                                });
                            }
                        } catch (e) {
                            console.log(`[add set] Error parsing ${pPath}: ${e}`);
                        }
                    }
                }
                
                if (!finalProject.general) { finalProject.general = {}; }
                finalProject.general.properties = finalProps;
                
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

        // Initialize WebSocket Server
        try {
            console.log(`[Server] Initializing WebSocket Server`);
            this.wss = new WebSocketServer({ noServer: true });
            
            this.server.on('upgrade', (request, socket, head) => {
                this.wss?.handleUpgrade(request, socket, head, (ws) => {
                    this.wss?.emit('connection', ws, request);
                });
            });

            this.wss.on('connection', (ws) => {
                console.log('[Server] WebSocket connected');
                ws.on('message', (message) => {
                    // Optional: Handle messages from clients
                });
            });
        } catch (error) {
            console.error('[Server] Failed to initialize WebSocket Server:', error);
            await this.stop();
            throw error;
        }
        
        console.log(`[server launch] Setting up server listeners`);
        try {
            const listening = waitForServerListening(this.server, SERVER_STARTUP_TIMEOUT_MS);
            try {
                this.server.listen(this.PORT, '127.0.0.1');
            } catch (error) {
                this.server.emit('error', error instanceof Error ? error : new Error(String(error)));
            }
            await listening;
            const address = this.server.address();
            if (address && typeof address !== 'string') {
                this.PORT = address.port;
            }
        } catch (error) {
            console.error('[server launch] Server failed to listen:', error);
            await this.stop();
            throw error;
        }

        this.resetShutdownTimer();
        await this.context.globalState.update('currentWallpaperPath', rootPath);
        await this.context.globalState.update('currentWallpaperEntry', this.entryFile);
        await this.context.globalState.update('currentWallpaperLocation', location);
        console.log(`[server launch] Wallpaper Server started on port ${this.PORT}${silent ? ' (silent)' : ''}`);
    }

    public async verifyHealth(timeoutMs = SERVER_PREFLIGHT_TIMEOUT_MS): Promise<void> {
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
            const status = JSON.parse(response.body) as { running?: boolean };
            if (status.running !== true) {
                throw new Error('running 状态无效');
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
                        const proj = JSON.parse(fs.readFileSync(projPath, "utf-8"));
                        let deps: string[] = [];
                        if (typeof proj.dependency === "string") {
                            deps = [proj.dependency];
                        } else if (Array.isArray(proj.dependency)) {
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

    public async stop(): Promise<void> {
        if (this.shutdownTimeout) {
            clearTimeout(this.shutdownTimeout);
            this.shutdownTimeout = null;
        }
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        if (this.server) {
            const activeServer = this.server;
            this.server = null;
            if (typeof activeServer.closeAllConnections === 'function') {
                activeServer.closeAllConnections();
            }
            await new Promise<void>((resolve, reject) => {
                if (!activeServer.listening) {
                    resolve();
                    return;
                }
                activeServer.close(error => error ? reject(error) : resolve());
            });
        }
        console.log('[Server] Server stopped.');
    }

    public broadcast(data: any) {
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
