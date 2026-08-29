import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    validateWallpaperMedia,
    waitForServerListening,
    WallpaperServer,
    WallpaperServerStartupTimeoutError,
    PersistedWallpaperStateError
} from '../core/server';

function createContext(): vscode.ExtensionContext {
    const values = new Map<string, unknown>();
    const globalState = {
        get<T>(key: string): T | undefined {
            return values.get(key) as T | undefined;
        },
        update(key: string, value: unknown): Thenable<void> {
            values.set(key, value);
            return Promise.resolve();
        },
        keys(): readonly string[] {
            return [...values.keys()];
        },
        setKeysForSync(): void {}
    };

    return { globalState } as unknown as vscode.ExtensionContext;
}

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('未能获取测试服务器端口'));
                return;
            }
            resolve(address.port);
        });
    });
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

function abortMediaRequest(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/media/current`, response => {
            response.once('data', () => {
                request.destroy();
                response.destroy();
                resolve();
            });
            response.once('error', error => {
                if (error.name === 'AbortError' || 'code' in error && error.code === 'ECONNRESET') {
                    resolve();
                    return;
                }
                reject(error);
            });
        });
        request.once('error', error => {
            if ('code' in error && error.code === 'ECONNRESET') {
                resolve();
                return;
            }
            reject(error);
        });
    });
}

suite('WallpaperServer lifecycle and preflight', () => {
    let root: string;
    let server: WallpaperServer | undefined;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-server-test-'));
        fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    });

    teardown(async () => {
        await server?.stop();
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('start resolves only after the server is listening and healthy', async () => {
        server = new WallpaperServer(createContext());

        await server.start(root, 0, 'index.html', root, true);

        const info = server.getCurrentInfo();
        assert.ok(info.port > 0);
        await server.verifyHealth();
        await server.verifyEntry();
    });

    test('start rejects when the requested port is occupied', async () => {
        const blocker = http.createServer();
        const port = await listen(blocker);
        server = new WallpaperServer(createContext());

        try {
            await assert.rejects(
                server.start(root, port, 'index.html', root, true),
                error => error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
            );
        } finally {
            await close(blocker);
        }
    });

    test('changing ports closes the old socket before binding the new one', async () => {
        server = new WallpaperServer(createContext());
        await server.start(root, 0, 'index.html', root, true);
        const oldPort = server.getCurrentInfo().port;
        const probe = http.createServer();
        const newPort = await listen(probe);
        await close(probe);

        await server.start(root, newPort, 'index.html', root, true);

        assert.strictEqual(server.getCurrentInfo().port, newPort);
        await assert.rejects(fetch(`http://127.0.0.1:${oldPort}/ping`));
        await server.verifyHealth();
    });

    test('changing to an occupied port rejects after closing the old socket', async () => {
        server = new WallpaperServer(createContext());
        await server.start(root, 0, 'index.html', root, true);
        const oldPort = server.getCurrentInfo().port;
        const blocker = http.createServer();
        const occupiedPort = await listen(blocker);

        try {
            await assert.rejects(
                server.start(root, occupiedPort, 'index.html', root, true),
                error => error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
            );
            await assert.rejects(fetch(`http://127.0.0.1:${oldPort}/ping`));
        } finally {
            await close(blocker);
        }
    });

    test('waitForServerListening rejects when listening does not complete before timeout', async () => {
        const pendingServer = new EventEmitter() as unknown as http.Server;

        await assert.rejects(
            waitForServerListening(pendingServer, 10),
            WallpaperServerStartupTimeoutError
        );
    });

    test('media validation rejects missing paths and directories', async () => {
        await assert.rejects(validateWallpaperMedia(path.join(root, 'missing.mp4')), /不存在|读取/);
        await assert.rejects(validateWallpaperMedia(root), /不是文件/);
    });

    test('media validation accepts a readable file', async () => {
        const mediaPath = path.join(root, 'video.mp4');
        fs.writeFileSync(mediaPath, 'media');

        await validateWallpaperMedia(mediaPath);
    });

    test('health and entry verification reject unavailable responses', async () => {
        server = new WallpaperServer(createContext());
        await server.start(root, 0, 'missing.html', root, true);

        await assert.rejects(server.verifyEntry(100), /入口/);
        await server.stop();
        await assert.rejects(server.verifyHealth(100), /健康检查/);
    });

    test('health verification rejects a service for a different wallpaper', async () => {
        server = new WallpaperServer(createContext());
        await server.start(root, 0, 'index.html', root, true);

        await assert.rejects(
            server.verifyHealth(100, { rootPath: path.join(root, 'other'), entryFile: 'index.html' }),
            /健康检查响应无效/
        );
        await assert.rejects(
            server.verifyHealth(100, { rootPath: root, entryFile: 'other.html' }),
            /健康检查响应无效/
        );
    });

    test('reload confirmation resolves only after a client consumes the signal', async () => {
        server = new WallpaperServer(createContext());
        await server.start(root, 0, 'index.html', root, true);

        const confirmation = server.triggerReloadAndWait(1000);
        const response = await fetch(`http://127.0.0.1:${server.getCurrentInfo().port}/ping`);

        assert.strictEqual(response.status, 205);
        await confirmation;
    });

    test('reload confirmation rejects when no client consumes the signal', async () => {
        server = new WallpaperServer(createContext());
        await server.start(root, 0, 'index.html', root, true);

        await assert.rejects(server.triggerReloadAndWait(20), /刷新信号.*超时/);
    });

    test('current media endpoint supports GET, HEAD and single byte ranges', async () => {
        const mediaPath = path.join(root, 'current.webm');
        fs.writeFileSync(mediaPath, '0123456789');
        server = new WallpaperServer(createContext());
        await server.start(root, 0, 'current.webm', root, true);
        const endpoint = `http://127.0.0.1:${server.getCurrentInfo().port}/media/current`;

        const full = await fetch(`${endpoint}?path=../ignored.webm`);
        assert.strictEqual(full.status, 200);
        assert.strictEqual(full.headers.get('content-type'), 'video/webm');
        assert.strictEqual(full.headers.get('content-length'), '10');
        assert.strictEqual(full.headers.get('accept-ranges'), 'bytes');
        assert.strictEqual(full.headers.get('cache-control'), 'no-store');
        assert.strictEqual(full.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(await full.text(), '0123456789');

        const head = await fetch(endpoint, { method: 'HEAD' });
        assert.strictEqual(head.status, 200);
        assert.strictEqual(head.headers.get('content-length'), '10');
        assert.strictEqual(await head.text(), '');

        const rangedHead = await fetch(endpoint, { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
        assert.strictEqual(rangedHead.status, 206);
        assert.strictEqual(rangedHead.headers.get('content-range'), 'bytes 2-5/10');
        assert.strictEqual(rangedHead.headers.get('content-length'), '4');
        assert.strictEqual(await rangedHead.text(), '');

        const first = await fetch(endpoint, { headers: { Range: 'bytes=0-3' } });
        assert.strictEqual(first.status, 206);
        assert.strictEqual(first.headers.get('content-range'), 'bytes 0-3/10');
        assert.strictEqual(first.headers.get('content-length'), '4');
        assert.strictEqual(await first.text(), '0123');

        const openEnded = await fetch(endpoint, { headers: { Range: 'bytes=7-' } });
        assert.strictEqual(openEnded.status, 206);
        assert.strictEqual(openEnded.headers.get('content-range'), 'bytes 7-9/10');
        assert.strictEqual(await openEnded.text(), '789');

        const suffix = await fetch(endpoint, { headers: { Range: 'bytes=-3' } });
        assert.strictEqual(suffix.status, 206);
        assert.strictEqual(suffix.headers.get('content-range'), 'bytes 7-9/10');
        assert.strictEqual(await suffix.text(), '789');
    });

    test('current media endpoint rejects invalid methods, ranges and paths outside current root', async () => {
        fs.writeFileSync(path.join(root, 'current.webm'), '0123456789');
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-media-outside-'));
        const outsideMedia = path.join(outside, 'secret.webm');
        fs.writeFileSync(outsideMedia, 'secret');
        server = new WallpaperServer(createContext());

        try {
            await server.start(root, 0, outsideMedia, root, true);
            let endpoint = `http://127.0.0.1:${server.getCurrentInfo().port}/media/current`;
            const escaped = await fetch(endpoint);
            assert.strictEqual(escaped.status, 404);
            assert.strictEqual(escaped.headers.get('cache-control'), 'no-store');
            assert.strictEqual(escaped.headers.get('x-content-type-options'), 'nosniff');

            await server.start(root, server.getCurrentInfo().port, 'current.webm', root, true);
            endpoint = `http://127.0.0.1:${server.getCurrentInfo().port}/media/current`;
            const invalidRanges = ['bytes=20-30', 'bytes=5-4', 'bytes=0-1,3-4', 'items=0-1', 'bytes=-0'];
            for (const range of invalidRanges) {
                const response = await fetch(endpoint, { headers: { Range: range } });
                assert.strictEqual(response.status, 416, range);
                assert.strictEqual(response.headers.get('content-range'), 'bytes */10');
                assert.strictEqual(response.headers.get('cache-control'), 'no-store');
                assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
            }

            const invalidHead = await fetch(endpoint, { method: 'HEAD', headers: { Range: 'bytes=99-' } });
            assert.strictEqual(invalidHead.status, 416);
            assert.strictEqual(invalidHead.headers.get('content-range'), 'bytes */10');

            const post = await fetch(endpoint, { method: 'POST' });
            assert.strictEqual(post.status, 405);
            assert.strictEqual(post.headers.get('allow'), 'GET, HEAD');
            assert.strictEqual(post.headers.get('cache-control'), 'no-store');
            assert.strictEqual(post.headers.get('x-content-type-options'), 'nosniff');
            const options = await fetch(endpoint, { method: 'OPTIONS' });
            assert.strictEqual(options.status, 204);
            assert.strictEqual(options.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    test('aborting a current media stream releases it and keeps the server healthy', async () => {
        fs.writeFileSync(path.join(root, 'large.webm'), Buffer.alloc(8 * 1024 * 1024, 1));
        server = new WallpaperServer(createContext());
        await server.start(root, 0, 'large.webm', root, true);
        const port = server.getCurrentInfo().port;

        await abortMediaRequest(port);

        const head = await fetch(`http://127.0.0.1:${port}/media/current`, { method: 'HEAD' });
        assert.strictEqual(head.status, 200);
        await server.verifyHealth();
    });

    test('playback endpoints validate bounded reports and expose current status', async () => {
        server = new WallpaperServer(createContext());
        await server.start(root, 0, 'index.html', root, true);
        const base = `http://127.0.0.1:${server.getCurrentInfo().port}`;

        const idle = await fetch(`${base}/playback-status`);
        assert.deepStrictEqual(await idle.json(), { state: 'idle' });

        const malformed = await fetch(`${base}/playback-event`, { method: 'POST', body: '{' });
        assert.strictEqual(malformed.status, 400);
        const invalid = await fetch(`${base}/playback-event`, {
            method: 'POST',
            body: JSON.stringify({ state: 'ready', mediaType: 'audio', event: 'playing' })
        });
        assert.strictEqual(invalid.status, 400);
        const oversized = await fetch(`${base}/playback-event`, { method: 'POST', body: 'x'.repeat(4097) });
        assert.strictEqual(oversized.status, 413);

        const accepted = await fetch(`${base}/playback-event`, {
            method: 'POST',
            body: JSON.stringify({
                state: 'ready',
                mediaType: 'video',
                event: 'time-progress',
                readyState: 4,
                networkState: 1,
                paused: false,
                currentTime: 1.5
            })
        });
        assert.strictEqual(accepted.status, 204);
        const status = await fetch(`${base}/playback-status`);
        const snapshot = await status.json() as { state: string; mediaType: string; event: string };
        assert.strictEqual(snapshot.state, 'ready');
        assert.strictEqual(snapshot.mediaType, 'video');
        assert.strictEqual(snapshot.event, 'time-progress');

        assert.strictEqual((await fetch(`${base}/playback-event`)).status, 405);
        assert.strictEqual((await fetch(`${base}/playback-status`, { method: 'POST' })).status, 405);
    });

    test('verifyPlaybackReady resolves ready, rejects errors and times out explicitly', async () => {
        server = new WallpaperServer(createContext());
        await server.start(root, 0, 'index.html', root, true);
        const endpoint = `http://127.0.0.1:${server.getCurrentInfo().port}/playback-event`;

        const ready = server.verifyPlaybackReady('video', 1000);
        await fetch(endpoint, {
            method: 'POST',
            body: JSON.stringify({ state: 'ready', mediaType: 'video', event: 'time-progress' })
        });
        await ready;

        await server.start(root, server.getCurrentInfo().port, 'index.html', root, true);
        const failed = server.verifyPlaybackReady('video', 1000);
        await fetch(endpoint, {
            method: 'POST',
            body: JSON.stringify({ state: 'error', mediaType: 'video', event: 'decode-error', errorCode: 3 })
        });
        await assert.rejects(failed, /媒体播放失败.*decode-error.*错误码 3/);

        await server.start(root, server.getCurrentInfo().port, 'index.html', root, true);
        await assert.rejects(server.verifyPlaybackReady('image', 20), /等待 image 播放就绪超时/);
    });

    test('hot swap resets a previously ready playback snapshot', async () => {
        fs.writeFileSync(path.join(root, 'other.html'), '<!doctype html><html><body>other</body></html>');
        server = new WallpaperServer(createContext());
        await server.start(root, 0, 'index.html', root, true);
        const port = server.getCurrentInfo().port;
        await fetch(`http://127.0.0.1:${port}/playback-event`, {
            method: 'POST',
            body: JSON.stringify({ state: 'ready', mediaType: 'web', event: 'iframe-load' })
        });
        await server.verifyPlaybackReady('web', 50);

        await server.start(root, port, 'other.html', root, true);

        await assert.rejects(server.verifyPlaybackReady('web', 20), /等待 web 播放就绪超时/);
        const status = await fetch(`http://127.0.0.1:${port}/playback-status`);
        assert.deepStrictEqual(await status.json(), { state: 'idle' });
    });

    test('verifyPlaybackReady reads a reused external server instead of local monitor state', async () => {
        const external = http.createServer((request, response) => {
            if (request.url === '/status') {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({
                    running: true,
                    rootPath: root,
                    entryFile: 'index.html'
                }));
                return;
            }
            if (request.url === '/playback-status') {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({
                    state: 'ready',
                    mediaType: 'web',
                    event: 'iframe-load',
                    updatedAt: Date.now()
                }));
                return;
            }
            response.statusCode = 404;
            response.end();
        });
        const port = await listen(external);
        server = new WallpaperServer(createContext());

        try {
            await server.start(root, port, 'index.html', root, true);
            await server.verifyPlaybackReady('web', 500);
        } finally {
            await close(external);
        }
    });

    test('clearPersistedWallpaperState clears recovery and pending setup keys', async () => {
        const values = new Map<string, unknown>([
            ['currentWallpaperPath', root],
            ['currentWallpaperEntry', 'index.html'],
            ['currentWallpaperLocation', root],
            ['currentWallpaperPlayback', { wallpaperId: 'wallpaper' }],
            ['pendingSetupConfirmation', { wallpaperId: 'wallpaper' }]
        ]);
        const context = {
            globalState: {
                get<T>(key: string): T | undefined { return values.get(key) as T | undefined; },
                update(key: string, value: unknown): Thenable<void> {
                    values.set(key, value);
                    return Promise.resolve();
                }
            }
        } as unknown as vscode.ExtensionContext;
        server = new WallpaperServer(context);

        await server.clearPersistedWallpaperState();

        for (const key of ['currentWallpaperPath', 'currentWallpaperEntry', 'currentWallpaperLocation', 'currentWallpaperPlayback', 'pendingSetupConfirmation']) {
            assert.strictEqual(values.get(key), undefined, `expected ${key} to be cleared`);
        }
    });

    test('stop preserves persisted recovery state for ordinary shutdowns', async () => {
        const values = new Map<string, unknown>([
            ['currentWallpaperPath', root],
            ['currentWallpaperEntry', 'index.html'],
            ['currentWallpaperLocation', root]
        ]);
        const context = {
            globalState: {
                get<T>(key: string): T | undefined { return values.get(key) as T | undefined; },
                update(key: string, value: unknown): Thenable<void> {
                    values.set(key, value);
                    return Promise.resolve();
                }
            }
        } as unknown as vscode.ExtensionContext;
        server = new WallpaperServer(context);

        await server.stop();

        assert.strictEqual(values.get('currentWallpaperPath'), root);
        assert.strictEqual(values.get('currentWallpaperEntry'), 'index.html');
        assert.strictEqual(values.get('currentWallpaperLocation'), root);
    });

    test('clearPersistedWallpaperState attempts every key before reporting failures', async () => {
        const updates: string[] = [];
        const context = {
            globalState: {
                get<T>(_key: string): T | undefined { return undefined; },
                update(key: string, _value: unknown): Thenable<void> {
                    updates.push(key);
                    if (key === 'currentWallpaperEntry') {
                        return Promise.reject(new Error('write failed'));
                    }
                    return Promise.resolve();
                }
            }
        } as unknown as vscode.ExtensionContext;
        server = new WallpaperServer(context);

        await assert.rejects(
            server.clearPersistedWallpaperState(),
            error => {
                if (!(error instanceof PersistedWallpaperStateError)) {
                    return false;
                }
                return error.failures.length === 1
                    && error.failures[0].key === 'currentWallpaperEntry';
            }
        );
        assert.deepStrictEqual(updates, [
            'currentWallpaperPath',
            'currentWallpaperEntry',
            'currentWallpaperLocation',
            'currentWallpaperPlayback',
            'pendingSetupConfirmation'
        ]);
    });
});
