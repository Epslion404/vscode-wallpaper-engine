import * as fs from 'fs';
import * as http from 'http';

const MAX_PREFLIGHT_RESPONSE_BYTES = 64 * 1024;

export type WallpaperPreflightKind = 'media' | 'health' | 'entry';

export class WallpaperPreflightError extends Error {
    constructor(
        public readonly kind: WallpaperPreflightKind,
        message: string,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'WallpaperPreflightError';
    }
}

export class WallpaperServerStartupTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`壁纸服务器在 ${timeoutMs} 毫秒内未完成监听`);
        this.name = 'WallpaperServerStartupTimeoutError';
    }
}

export interface LocalEndpointResponse {
    statusCode: number;
    contentType: string;
    body: string;
}

/** 等待 Node HTTP server 真正进入 listening 状态。 */
export function waitForServerListening(
    server: http.Server,
    timeoutMs: number
): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            server.removeListener('listening', onListening);
            server.removeListener('error', onError);
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };
        const onListening = () => finish();
        const onError = (error: Error) => finish(error);
        const timeout = setTimeout(() => {
            try {
                server.close();
            } catch {
                // 未进入监听状态时 close 可能抛错，超时错误仍是调用方所需的主错误。
            }
            finish(new WallpaperServerStartupTimeoutError(timeoutMs));
        }, timeoutMs);

        server.once('listening', onListening);
        server.once('error', onError);
    });
}

export async function validateWallpaperMedia(mediaPath: string): Promise<void> {
    let stats: fs.Stats;
    try {
        stats = await fs.promises.stat(mediaPath);
    } catch (error) {
        throw new WallpaperPreflightError('media', `壁纸媒体不存在或无法读取: ${mediaPath}`, {
            cause: error
        });
    }

    if (!stats.isFile()) {
        throw new WallpaperPreflightError('media', `壁纸媒体不是文件: ${mediaPath}`);
    }

    try {
        const handle = await fs.promises.open(mediaPath, 'r');
        await handle.close();
    } catch (error) {
        throw new WallpaperPreflightError('media', `壁纸媒体无法读取: ${mediaPath}`, {
            cause: error
        });
    }
    console.log(`[Server Preflight] Media is readable: ${mediaPath}`);
}

export function requestLocalEndpoint(port: number, requestPath: string, timeoutMs: number): Promise<LocalEndpointResponse> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        };
        const request = http.get({
            hostname: '127.0.0.1',
            port,
            path: requestPath,
            agent: false
        }, response => {
            const chunks: Buffer[] = [];
            let receivedBytes = 0;
            response.on('data', chunk => {
                receivedBytes += Buffer.byteLength(chunk);
                if (receivedBytes > MAX_PREFLIGHT_RESPONSE_BYTES) {
                    response.destroy(new Error('本地预检响应过大'));
                    return;
                }
                chunks.push(Buffer.from(chunk));
            });
            response.on('error', fail);
            response.on('end', () => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve({
                    statusCode: response.statusCode || 0,
                    contentType: String(response.headers['content-type'] || ''),
                    body: Buffer.concat(chunks).toString('utf-8')
                });
            });
        });
        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`本地预检请求在 ${timeoutMs} 毫秒后超时`));
        });
        request.on('error', fail);
    });
}
