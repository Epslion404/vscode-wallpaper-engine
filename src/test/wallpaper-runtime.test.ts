import * as assert from 'assert';
import { evaluateUninstallSupersession, isPendingSetupState, needsWallpaperInjection } from '../core/wallpaper-runtime';

suite('Wallpaper Runtime Test Suite', () => {
    test('a newer matching setup supersedes the stale uninstall transaction', () => {
        const decision = evaluateUninstallSupersession({
            uninstallCreatedAt: 1787891751224,
            setupCreatedAt: 1787891824468,
            setupWallpaperId: '3422060536',
            currentWallpaperId: '3422060536',
            setupPath: 'E:/workshop/3422060536',
            persistedPath: 'E:/workshop/3422060536',
            setupEntry: 'wallpaper.mp4',
            persistedEntry: 'wallpaper.mp4'
        });

        assert.deepStrictEqual(decision, {
            superseded: true,
            reason: 'newer-matching-setup'
        });
    });

    test('does not supersede when the setup is not newer, does not match, or state is incomplete', () => {
        const base = {
            uninstallCreatedAt: 1000,
            setupCreatedAt: 2000,
            setupWallpaperId: '123',
            currentWallpaperId: '123',
            setupPath: 'E:/workshop/123',
            persistedPath: 'E:/workshop/123',
            setupEntry: 'index.html',
            persistedEntry: 'index.html'
        };

        assert.strictEqual(evaluateUninstallSupersession({ ...base, setupCreatedAt: 1000 }).superseded, false);
        assert.strictEqual(evaluateUninstallSupersession({ ...base, setupWallpaperId: '456' }).superseded, false);
        assert.strictEqual(evaluateUninstallSupersession({ ...base, persistedPath: 'E:/workshop/456' }).superseded, false);
        assert.strictEqual(evaluateUninstallSupersession({ ...base, persistedEntry: 'other.html' }).superseded, false);
    });

    test('normalizes Windows path separators and trailing slashes before matching', () => {
        const decision = evaluateUninstallSupersession({
            uninstallCreatedAt: 1000,
            setupCreatedAt: 2000,
            setupWallpaperId: '123',
            currentWallpaperId: '123',
            setupPath: 'E:/Workshop/123/',
            persistedPath: 'e:\\workshop\\123',
            setupEntry: 'index.html',
            persistedEntry: 'index.html'
        });

        assert.strictEqual(decision.superseded, true);
    });

    test('does not supersede malformed setup state', () => {
        assert.strictEqual(
            evaluateUninstallSupersession({
                uninstallCreatedAt: 1000,
                setupCreatedAt: Number.NaN,
                setupWallpaperId: '123',
                currentWallpaperId: '123',
                setupPath: 'E:/workshop/123',
                persistedPath: 'E:/workshop/123',
                setupEntry: 'index.html',
                persistedEntry: 'index.html'
            }).superseded,
            false
        );
    });

    test('accepts only structurally valid pending setup records', () => {
        assert.strictEqual(isPendingSetupState({
            operationId: 'op',
            wallpaperId: '123',
            wallpaperTitle: 'Demo',
            dirPath: 'E:/workshop/123',
            fileName: 'index.html',
            createdAt: 2000
        }), true);
        assert.strictEqual(isPendingSetupState({ wallpaperId: '123' }), false);
        assert.strictEqual(isPendingSetupState(null), false);
    });

    test('requests recovery when persisted wallpaper exists but Workbench is unpatched', () => {
        assert.strictEqual(needsWallpaperInjection({
            disabled: false,
            serviceHealthy: true,
            persistedPath: 'D:/wallpapers/123',
            persistedEntry: 'index.html',
            workbenchPatched: false
        }), true);
    });

    test('does not request recovery when the extension is disabled or already patched', () => {
        assert.strictEqual(needsWallpaperInjection({
            disabled: true,
            serviceHealthy: true,
            persistedPath: 'D:/wallpapers/123',
            persistedEntry: 'index.html',
            workbenchPatched: false
        }), false);
        assert.strictEqual(needsWallpaperInjection({
            disabled: false,
            serviceHealthy: true,
            persistedPath: 'D:/wallpapers/123',
            persistedEntry: 'index.html',
            workbenchPatched: true
        }), false);
    });

    test('does not request recovery when the wallpaper service is unavailable', () => {
        assert.strictEqual(needsWallpaperInjection({
            disabled: false,
            serviceHealthy: false,
            persistedPath: 'D:/wallpapers/123',
            persistedEntry: 'index.html',
            workbenchPatched: false
        }), false);
    });

    test('does not request recovery when persisted state is incomplete', () => {
        assert.strictEqual(needsWallpaperInjection({
            disabled: false,
            serviceHealthy: true,
            persistedPath: 'D:/wallpapers/123',
            workbenchPatched: false
        }), false);
        assert.strictEqual(needsWallpaperInjection({
            disabled: false,
            serviceHealthy: true,
            persistedEntry: 'index.html',
            workbenchPatched: false
        }), false);
    });
});
