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
