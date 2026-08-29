import * as assert from 'assert';
import { WallpaperType } from '../core/types';
import {
    isExpectedReloadCancellation,
    isPendingSetupConfirmation,
    isPendingConfirmationFresh,
    PendingSetupConfirmation,
    shouldConfirmPendingSetup,
    confirmPendingSetupPlayback,
    WallpaperSetupError,
    WallpaperSetupInput,
    WallpaperSetupStage,
    runWallpaperSetup
} from '../core/wallpaper-setup';

const input: WallpaperSetupInput = {
    wallpaperId: '123',
    wallpaperTitle: '测试壁纸',
    dirPath: 'D:/wallpapers/123',
    filePath: 'D:/wallpapers/123/index.html',
    fileName: 'index.html',
    type: WallpaperType.Web,
    port: 23333,
    opacity: 0.1,
    resizeDelay: 500,
    startupCheckInterval: 300
};

suite('Wallpaper Setup Test Suite', () => {
    test('runs every setup stage before reporting success', async () => {
        const calls: string[] = [];

        const result = await runWallpaperSetup(input, {
            validateMedia: async () => { calls.push('validate'); },
            startServer: async () => { calls.push('server'); },
            verifyHealth: async () => { calls.push('health'); },
            verifyEntry: async () => { calls.push('verify'); },
            applyTransparency: async () => { calls.push('transparency'); },
            inject: async () => { calls.push('inject'); },
            updateWallpaperId: async id => { calls.push(`config:${id}`); },
            savePendingConfirmation: async confirmation => { calls.push(`confirm:${confirmation.wallpaperId}`); },
            reloadWorkbench: async () => { calls.push('reload'); },
            rollback: async () => { calls.push('rollback'); },
            report: stage => { calls.push(`stage:${stage}`); },
            createOperationId: () => 'operation-1',
            now: () => 1000
        });

        assert.strictEqual(result.operationId, 'operation-1');
        assert.strictEqual(result.confirmation.playbackType, WallpaperType.Web);
        assert.deepStrictEqual(calls, [
            `stage:${WallpaperSetupStage.ValidateMedia}`,
            'validate',
            `stage:${WallpaperSetupStage.StartServer}`,
            'server',
            `stage:${WallpaperSetupStage.VerifyHealth}`,
            'health',
            `stage:${WallpaperSetupStage.VerifyEntry}`,
            'verify',
            `stage:${WallpaperSetupStage.ApplyTransparency}`,
            'transparency',
            `stage:${WallpaperSetupStage.InjectWorkbench}`,
            'inject',
            `stage:${WallpaperSetupStage.SaveConfiguration}`,
            'config:123',
            'confirm:123',
            `stage:${WallpaperSetupStage.ReloadWorkbench}`,
            'reload'
        ]);
    });

    test('wraps a stage failure and rolls back the previous wallpaper', async () => {
        const calls: string[] = [];

        await assert.rejects(
            runWallpaperSetup(input, {
                validateMedia: async () => { calls.push('validate'); },
                startServer: async () => { throw new Error('端口被占用'); },
                verifyHealth: async () => { calls.push('health'); },
                verifyEntry: async () => { calls.push('verify'); },
                applyTransparency: async () => { calls.push('transparency'); },
                inject: async () => { calls.push('inject'); },
                updateWallpaperId: async () => { calls.push('config'); },
                savePendingConfirmation: async () => { calls.push('confirm'); },
                reloadWorkbench: async () => { calls.push('reload'); },
                rollback: async () => { calls.push('rollback'); },
                report: stage => { calls.push(`stage:${stage}`); },
                createOperationId: () => 'operation-2',
                now: () => 2000
            }),
            error => {
                if (!(error instanceof WallpaperSetupError)) {
                    return false;
                }
                assert.strictEqual(error.stage, WallpaperSetupStage.StartServer);
                assert.match(error.message, /端口被占用/);
                return true;
            }
        );

        assert.deepStrictEqual(calls, [
            `stage:${WallpaperSetupStage.ValidateMedia}`,
            'validate',
            `stage:${WallpaperSetupStage.StartServer}`,
            'rollback'
        ]);
    });

    test('keeps the original failure when rollback also fails', async () => {
        await assert.rejects(
            runWallpaperSetup(input, {
                validateMedia: async () => undefined,
                startServer: async () => undefined,
                verifyHealth: async () => undefined,
                verifyEntry: async () => undefined,
                applyTransparency: async () => undefined,
                inject: async () => { throw new Error('无法写入 Workbench'); },
                updateWallpaperId: async () => undefined,
                savePendingConfirmation: async () => undefined,
                reloadWorkbench: async () => undefined,
                rollback: async () => { throw new Error('回滚失败'); },
                report: () => undefined,
                createOperationId: () => 'operation-3',
                now: () => 3000
            }),
            error => {
                if (!(error instanceof WallpaperSetupError)) {
                    return false;
                }
                assert.strictEqual(error.stage, WallpaperSetupStage.InjectWorkbench);
                assert.match(error.message, /无法写入 Workbench/);
                assert.match(error.rollbackMessage ?? '', /回滚失败/);
                return true;
            }
        );
    });

    test('classifies configuration commit failure and restores the previous configuration and server', async () => {
        let wallpaperId = 'old-wallpaper';
        let serverRoot = 'D:/wallpapers/old-wallpaper';
        const calls: string[] = [];

        await assert.rejects(
            runWallpaperSetup(input, {
                validateMedia: async () => undefined,
                startServer: async setup => { serverRoot = setup.dirPath; },
                verifyHealth: async () => undefined,
                verifyEntry: async () => undefined,
                applyTransparency: async () => undefined,
                inject: async () => undefined,
                updateWallpaperId: async id => {
                    wallpaperId = id;
                    throw new Error('无法保存配置');
                },
                savePendingConfirmation: async () => { calls.push('confirm'); },
                reloadWorkbench: async () => { calls.push('reload'); },
                rollback: async () => {
                    wallpaperId = 'old-wallpaper';
                    serverRoot = 'D:/wallpapers/old-wallpaper';
                    calls.push('rollback');
                },
                report: () => undefined,
                createOperationId: () => 'operation-config-failure',
                now: () => 4000
            }),
            error => {
                assert.ok(error instanceof WallpaperSetupError);
                assert.strictEqual(error.stage, WallpaperSetupStage.SaveConfiguration);
                assert.match(error.message, /无法保存配置/);
                return true;
            }
        );

        assert.strictEqual(wallpaperId, 'old-wallpaper');
        assert.strictEqual(serverRoot, 'D:/wallpapers/old-wallpaper');
        assert.deepStrictEqual(calls, ['rollback']);
    });

    test('classifies reload failure and rolls back committed configuration and pending confirmation', async () => {
        let wallpaperId = 'old-wallpaper';
        let serverRoot = 'D:/wallpapers/old-wallpaper';
        let pendingWallpaperId: string | undefined;
        const calls: string[] = [];

        await assert.rejects(
            runWallpaperSetup(input, {
                validateMedia: async () => undefined,
                startServer: async setup => { serverRoot = setup.dirPath; },
                verifyHealth: async () => undefined,
                verifyEntry: async () => undefined,
                applyTransparency: async () => undefined,
                inject: async () => undefined,
                updateWallpaperId: async id => { wallpaperId = id; },
                savePendingConfirmation: async confirmation => { pendingWallpaperId = confirmation.wallpaperId; },
                reloadWorkbench: async () => { throw new Error('窗口重载命令失败'); },
                rollback: async () => {
                    wallpaperId = 'old-wallpaper';
                    serverRoot = 'D:/wallpapers/old-wallpaper';
                    pendingWallpaperId = undefined;
                    calls.push('rollback');
                },
                report: stage => { calls.push(`stage:${stage}`); },
                createOperationId: () => 'operation-reload-failure',
                now: () => 5000
            }),
            error => {
                assert.ok(error instanceof WallpaperSetupError);
                assert.strictEqual(error.stage, WallpaperSetupStage.ReloadWorkbench);
                assert.match(error.message, /窗口重载命令失败/);
                return true;
            }
        );

        assert.strictEqual(wallpaperId, 'old-wallpaper');
        assert.strictEqual(serverRoot, 'D:/wallpapers/old-wallpaper');
        assert.strictEqual(pendingWallpaperId, undefined);
        assert.deepStrictEqual(calls.slice(-2), [`stage:${WallpaperSetupStage.ReloadWorkbench}`, 'rollback']);
    });

    test('treats expected Reload Window cancellation as handoff without rollback', async () => {
        const calls: string[] = [];
        let pending: PendingSetupConfirmation | undefined;
        const cancellation = new Error('Canceled');
        cancellation.name = 'CancellationError';

        const result = await runWallpaperSetup(input, {
            validateMedia: async () => undefined,
            startServer: async () => undefined,
            verifyHealth: async () => undefined,
            verifyEntry: async () => undefined,
            applyTransparency: async () => undefined,
            inject: async () => undefined,
            updateWallpaperId: async () => undefined,
            savePendingConfirmation: async confirmation => {
                pending = confirmation;
                calls.push('pending-saved');
            },
            reloadWorkbench: async () => { throw cancellation; },
            rollback: async () => { calls.push('rollback'); },
            report: stage => { calls.push(`stage:${stage}`); },
            createOperationId: () => 'operation-reload-cancelled',
            now: () => 5500
        });

        assert.strictEqual(result.operationId, 'operation-reload-cancelled');
        assert.strictEqual(result.confirmation, pending);
        assert.strictEqual(result.confirmation.playbackType, WallpaperType.Web);
        assert.ok(calls.includes('pending-saved'));
        assert.ok(!calls.includes('rollback'));
    });

    test('keeps configuration commit failure when restoring the old state also fails', async () => {
        await assert.rejects(
            runWallpaperSetup(input, {
                validateMedia: async () => undefined,
                startServer: async () => undefined,
                verifyHealth: async () => undefined,
                verifyEntry: async () => undefined,
                applyTransparency: async () => undefined,
                inject: async () => undefined,
                updateWallpaperId: async () => { throw new Error('配置提交失败'); },
                savePendingConfirmation: async () => undefined,
                reloadWorkbench: async () => undefined,
                rollback: async () => { throw new Error('旧服务恢复失败'); },
                report: () => undefined,
                createOperationId: () => 'operation-double-failure',
                now: () => 6000
            }),
            error => {
                assert.ok(error instanceof WallpaperSetupError);
                assert.strictEqual(error.stage, WallpaperSetupStage.SaveConfiguration);
                assert.strictEqual(error.message, '配置提交失败');
                assert.strictEqual(error.rollbackMessage, '旧服务恢复失败');
                assert.ok(error.cause instanceof Error);
                assert.strictEqual(error.cause.message, '配置提交失败');
                return true;
            }
        );
    });

    test('accepts only recent pending confirmations', () => {
        const confirmation: PendingSetupConfirmation = {
            operationId: 'operation-4',
            wallpaperId: '123',
            wallpaperTitle: '测试壁纸',
            dirPath: 'D:/wallpapers/123',
            fileName: 'index.html',
            playbackType: WallpaperType.Web,
            createdAt: 1000
        };

        assert.strictEqual(isPendingConfirmationFresh(confirmation, 1000), true);
        assert.strictEqual(isPendingConfirmationFresh(confirmation, 1000 + 5 * 60 * 1000), true);
        assert.strictEqual(isPendingConfirmationFresh(confirmation, 1000 + 5 * 60 * 1000 + 1), false);
        assert.strictEqual(isPendingConfirmationFresh(confirmation, 999), false);
    });

    test('confirms pending setup only when wallpaper is unchanged and confirmation is fresh', () => {
        const confirmation: PendingSetupConfirmation = {
            operationId: 'operation-5',
            wallpaperId: '123',
            wallpaperTitle: '测试壁纸',
            dirPath: 'D:/wallpapers/123',
            fileName: 'index.html',
            playbackType: WallpaperType.Web,
            createdAt: 1000
        };

        assert.strictEqual(shouldConfirmPendingSetup(confirmation, '123', 1000), true);
        assert.strictEqual(shouldConfirmPendingSetup(confirmation, 'changed', 1000), false);
        assert.strictEqual(shouldConfirmPendingSetup(confirmation, '123', 1000 + 5 * 60 * 1000 + 1), false);
        assert.strictEqual(shouldConfirmPendingSetup({ ...confirmation, dirPath: '' }, '123', 1000), false);
        assert.strictEqual(shouldConfirmPendingSetup({ ...confirmation, fileName: '' }, '123', 1000), false);
    });

    test('strictly rejects old or malformed pending setup records', () => {
        const valid = {
            operationId: 'operation-6',
            wallpaperId: '123',
            wallpaperTitle: '测试壁纸',
            dirPath: 'D:/wallpapers/123',
            fileName: 'index.html',
            playbackType: WallpaperType.Web,
            createdAt: 1000
        };

        assert.strictEqual(isPendingSetupConfirmation(valid), true);
        const { playbackType: _removed, ...oldStructure } = valid;
        assert.strictEqual(isPendingSetupConfirmation(oldStructure), false);
        assert.strictEqual(isPendingSetupConfirmation({ ...valid, playbackType: 'scene' }), false);
        assert.strictEqual(isPendingSetupConfirmation({ ...valid, createdAt: Number.NaN }), false);
        assert.strictEqual(isPendingSetupConfirmation({ ...valid, wallpaperTitle: '' }), false);
    });

    test('recognizes only exact expected reload cancellation markers', () => {
        const cancellationError = new Error('Canceled');
        cancellationError.name = 'CancellationError';

        assert.strictEqual(isExpectedReloadCancellation(cancellationError), true);
        assert.strictEqual(isExpectedReloadCancellation({ name: 'Canceled', message: '' }), true);
        assert.strictEqual(isExpectedReloadCancellation({ code: 'Canceled' }), true);
        assert.strictEqual(isExpectedReloadCancellation(new Error('Canceled while saving configuration')), false);
        assert.strictEqual(isExpectedReloadCancellation(new Error('窗口重载失败')), false);
    });

    test('verifies service, media entry and actual playback before success', async () => {
        const confirmation: PendingSetupConfirmation = {
            operationId: 'operation-ready',
            wallpaperId: '123',
            wallpaperTitle: '测试壁纸',
            dirPath: 'D:/wallpapers/123',
            fileName: 'wallpaper.webm',
            playbackType: WallpaperType.Video,
            createdAt: 1000
        };
        const calls: string[] = [];

        await confirmPendingSetupPlayback(confirmation, {
            verifyHealth: async value => { calls.push(`health:${value.fileName}`); },
            verifyEntry: async () => { calls.push('entry'); },
            verifyPlaybackReady: async (type, minimumUpdatedAt) => {
                calls.push(`ready:${type}:${minimumUpdatedAt}`);
            },
            clearPendingConfirmation: async () => { calls.push('pending-cleared'); },
            report: stage => { calls.push(`stage:${stage}`); }
        });

        assert.deepStrictEqual(calls, [
            `stage:${WallpaperSetupStage.VerifyHealth}`,
            'health:wallpaper.webm',
            `stage:${WallpaperSetupStage.VerifyEntry}`,
            'entry',
            `stage:${WallpaperSetupStage.VerifyPlayback}`,
            'ready:video:1000',
            `stage:${WallpaperSetupStage.FinalizePlayback}`,
            'pending-cleared'
        ]);
    });

    test('classifies playback timeout at the playback-ready stage', async () => {
        const confirmation: PendingSetupConfirmation = {
            operationId: 'operation-timeout',
            wallpaperId: '123',
            wallpaperTitle: '测试壁纸',
            dirPath: 'D:/wallpapers/123',
            fileName: 'wallpaper.webm',
            playbackType: WallpaperType.Video,
            createdAt: 1000
        };

        let pendingCleared = false;
        await assert.rejects(confirmPendingSetupPlayback(confirmation, {
            verifyHealth: async () => undefined,
            verifyEntry: async () => undefined,
            verifyPlaybackReady: async () => { throw new Error('播放就绪等待超时'); },
            clearPendingConfirmation: async () => { pendingCleared = true; },
            report: () => undefined
        }), error => {
            assert.ok(error instanceof WallpaperSetupError);
            assert.strictEqual(error.stage, WallpaperSetupStage.VerifyPlayback);
            assert.match(error.message, /超时/);
            return true;
        });
        assert.strictEqual(pendingCleared, false);
    });

    test('classifies a media loading error without attempting playback verification', async () => {
        const confirmation: PendingSetupConfirmation = {
            operationId: 'operation-media-error',
            wallpaperId: '123',
            wallpaperTitle: '测试壁纸',
            dirPath: 'D:/wallpapers/123',
            fileName: 'wallpaper.webm',
            playbackType: WallpaperType.Video,
            createdAt: 1000
        };
        let playbackChecked = false;

        await assert.rejects(confirmPendingSetupPlayback(confirmation, {
            verifyHealth: async () => undefined,
            verifyEntry: async () => { throw new Error('媒体入口加载失败'); },
            verifyPlaybackReady: async () => { playbackChecked = true; },
            clearPendingConfirmation: async () => undefined,
            report: () => undefined
        }), error => {
            assert.ok(error instanceof WallpaperSetupError);
            assert.strictEqual(error.stage, WallpaperSetupStage.VerifyEntry);
            assert.match(error.message, /媒体入口加载失败/);
            return true;
        });
        assert.strictEqual(playbackChecked, false);
    });

    test('classifies a media element error reported by playback readiness', async () => {
        const confirmation: PendingSetupConfirmation = {
            operationId: 'operation-media-element-error',
            wallpaperId: '123',
            wallpaperTitle: '测试壁纸',
            dirPath: 'D:/wallpapers/123',
            fileName: 'wallpaper.webm',
            playbackType: WallpaperType.Video,
            createdAt: 1000
        };

        let pendingCleared = false;
        await assert.rejects(confirmPendingSetupPlayback(confirmation, {
            verifyHealth: async () => undefined,
            verifyEntry: async () => undefined,
            verifyPlaybackReady: async () => { throw new Error('媒体播放失败：decode-error，code=3'); },
            clearPendingConfirmation: async () => { pendingCleared = true; },
            report: () => undefined
        }), error => {
            assert.ok(error instanceof WallpaperSetupError);
            assert.strictEqual(error.stage, WallpaperSetupStage.VerifyPlayback);
            assert.match(error.message, /decode-error/);
            return true;
        });
        assert.strictEqual(pendingCleared, false);
    });

    test('distinguishes confirmation persistence failure from media playback failure', async () => {
        const confirmation: PendingSetupConfirmation = {
            operationId: 'operation-finalize-error',
            wallpaperId: '123',
            wallpaperTitle: '测试壁纸',
            dirPath: 'D:/wallpapers/123',
            fileName: 'wallpaper.webm',
            playbackType: WallpaperType.Video,
            createdAt: 1000
        };

        await assert.rejects(confirmPendingSetupPlayback(confirmation, {
            verifyHealth: async () => undefined,
            verifyEntry: async () => undefined,
            verifyPlaybackReady: async () => undefined,
            clearPendingConfirmation: async () => { throw new Error('无法保存确认状态'); },
            report: () => undefined
        }), error => {
            assert.ok(error instanceof WallpaperSetupError);
            assert.strictEqual(error.stage, WallpaperSetupStage.FinalizePlayback);
            assert.match(error.message, /无法保存确认状态/);
            return true;
        });
    });
});
