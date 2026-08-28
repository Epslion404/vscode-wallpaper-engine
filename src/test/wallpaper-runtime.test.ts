import * as assert from 'assert';
import { needsWallpaperInjection } from '../core/wallpaper-runtime';

suite('Wallpaper Runtime Test Suite', () => {
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
