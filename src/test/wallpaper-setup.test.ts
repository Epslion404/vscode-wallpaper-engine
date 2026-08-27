import * as assert from 'assert';
import { WallpaperType } from '../core/types';
import {
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
            verifyEntry: async () => { calls.push('verify'); },
            applyTransparency: async () => { calls.push('transparency'); },
            inject: async () => { calls.push('inject'); },
            updateWallpaperId: async id => { calls.push(`config:${id}`); },
            savePendingConfirmation: async confirmation => { calls.push(`confirm:${confirmation.wallpaperId}`); },
            rollback: async () => { calls.push('rollback'); },
            report: stage => { calls.push(`stage:${stage}`); },
            createOperationId: () => 'operation-1',
            now: () => 1000
        });

        assert.strictEqual(result.operationId, 'operation-1');
        assert.deepStrictEqual(calls, [
            `stage:${WallpaperSetupStage.ValidateMedia}`,
            'validate',
            `stage:${WallpaperSetupStage.StartServer}`,
            'server',
            `stage:${WallpaperSetupStage.VerifyEntry}`,
            'verify',
            `stage:${WallpaperSetupStage.ApplyTransparency}`,
            'transparency',
            `stage:${WallpaperSetupStage.InjectWorkbench}`,
            'inject',
            `stage:${WallpaperSetupStage.SaveConfiguration}`,
            'config:123',
            'confirm:123'
        ]);
    });

    test('wraps a stage failure and rolls back the previous wallpaper', async () => {
        const calls: string[] = [];

        await assert.rejects(
            runWallpaperSetup(input, {
                validateMedia: async () => { calls.push('validate'); },
                startServer: async () => { throw new Error('端口被占用'); },
                verifyEntry: async () => { calls.push('verify'); },
                applyTransparency: async () => { calls.push('transparency'); },
                inject: async () => { calls.push('inject'); },
                updateWallpaperId: async () => { calls.push('config'); },
                savePendingConfirmation: async () => { calls.push('confirm'); },
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
                verifyEntry: async () => undefined,
                applyTransparency: async () => undefined,
                inject: async () => { throw new Error('无法写入 Workbench'); },
                updateWallpaperId: async () => undefined,
                savePendingConfirmation: async () => undefined,
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
});
