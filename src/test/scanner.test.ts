import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getWallpaperById, scanWallpapers, scanWallpapersWithDiagnostics } from '../core/scanner';
import { WallpaperType } from '../core/types';

suite('Scanner Test Suite', () => {
    let tempDir: string;

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-wallpaper-test-'));
    });

    teardown(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {
            console.error('Failed to clean up temp dir:', e);
        }
    });

    test('scanWallpapers should find valid wallpapers', () => {
        // Create a valid wallpaper dir
        const wpDir = path.join(tempDir, '12345');
        fs.mkdirSync(wpDir);
        fs.writeFileSync(path.join(wpDir, 'project.json'), JSON.stringify({
            title: 'Test Wallpaper',
            file: 'video.mp4',
            type: 'video'
        }));

        const items = scanWallpapers(tempDir);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].label, '$(device-camera-video) Test Wallpaper');
        assert.strictEqual(items[0].type, WallpaperType.Video);
    });

    test('scanWallpapers should ignore invalid types', () => {
        const wpDir = path.join(tempDir, '67890');
        fs.mkdirSync(wpDir);
        fs.writeFileSync(path.join(wpDir, 'project.json'), JSON.stringify({
            title: 'Invalid Wallpaper',
            file: 'scene.pkg',
            type: 'unknown_type' // Not in allowed list
        }));

        const items = scanWallpapers(tempDir);
        assert.strictEqual(items.length, 0);
    });

    test('scanWallpapers should expose native scene wallpapers for recording', () => {
        const wpDir = path.join(tempDir, 'scene-wallpaper');
        fs.mkdirSync(wpDir);
        fs.writeFileSync(path.join(wpDir, 'project.json'), JSON.stringify({
            title: 'Native Scene Wallpaper',
            file: 'scene.pkg',
            type: 'scene'
        }));
        fs.writeFileSync(path.join(wpDir, 'scene.pkg'), 'scene package');

        const items = scanWallpapers(tempDir);

        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].type, WallpaperType.Scene);
        assert.strictEqual(items[0].description, 'ID: scene-wallpaper [scene]');
        assert.strictEqual(items[0].getSceneSource().projectJsonPath, path.join(wpDir, 'project.json'));
        assert.strictEqual(items[0].getSceneSource().sourcePath, path.join(wpDir, 'scene.pkg'));
        assert.throws(() => items[0].getMediaPath(), /必须先录制/);
    });

    test('Scene source resolution rejects declared path traversal and uses scene.pkg', () => {
        const wpDir = path.join(tempDir, 'scene-safe-source');
        fs.mkdirSync(wpDir);
        fs.writeFileSync(path.join(wpDir, 'project.json'), JSON.stringify({
            title: 'Safe Scene',
            file: '..\\outside.pkg',
            type: 'scene'
        }));
        fs.writeFileSync(path.join(wpDir, 'scene.pkg'), 'safe package');

        const item = getWallpaperById(tempDir, 'scene-safe-source');

        assert.ok(item);
        assert.strictEqual(item.getSceneSource().sourcePath, path.join(wpDir, 'scene.pkg'));
    });

    test('getWallpaperById should reject paths outside the workshop root', () => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-wallpaper-outside-test-'));
        fs.writeFileSync(path.join(outsideDir, 'project.json'), JSON.stringify({
            title: 'Outside Wallpaper',
            file: 'index.html',
            type: 'web'
        }));

        try {
            const escapedId = path.relative(tempDir, outsideDir);
            const item = getWallpaperById(tempDir, escapedId);

            assert.strictEqual(item, null);
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }
    });

    test('scanWallpapers should reject dependencies outside the workshop root', () => {
        const wpDir = path.join(tempDir, 'dependent-wallpaper');
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-wallpaper-dependency-test-'));
        fs.mkdirSync(wpDir);
        fs.writeFileSync(path.join(wpDir, 'project.json'), JSON.stringify({
            title: 'Dependent Wallpaper',
            dependency: path.relative(tempDir, outsideDir)
        }));
        fs.writeFileSync(path.join(outsideDir, 'project.json'), JSON.stringify({
            title: 'Outside Dependency',
            file: 'index.html',
            type: 'web'
        }));

        try {
            const items = scanWallpapers(tempDir);

            assert.strictEqual(items.length, 0);
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }
    });

    test('scanWallpapers should ignore malformed dependency ids', () => {
        const wpDir = path.join(tempDir, 'malformed-dependency');
        fs.mkdirSync(wpDir);
        fs.writeFileSync(path.join(wpDir, 'project.json'), JSON.stringify({
            title: 'Malformed Dependency',
            dependency: { id: 'not-a-string' }
        }));

        const items = scanWallpapers(tempDir);

        assert.strictEqual(items.length, 0);
    });

    test('scanWallpapers should reject wallpaper symlinks outside the workshop root', () => {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-wallpaper-symlink-test-'));
        const linkPath = path.join(tempDir, 'linked-wallpaper');
        fs.writeFileSync(path.join(outsideDir, 'project.json'), JSON.stringify({
            title: 'Linked Outside Wallpaper',
            file: 'index.html',
            type: 'web'
        }));
        fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

        try {
            const items = scanWallpapers(tempDir);

            assert.strictEqual(items.length, 0);
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }
    });
    
    test('scanWallpapers should handle missing project.json', () => {
        const wpDir = path.join(tempDir, 'empty');
        fs.mkdirSync(wpDir);
        
        const items = scanWallpapers(tempDir);
        assert.strictEqual(items.length, 0);
    });

    test('scanWallpapers should handle malformed project.json', () => {
        const wpDir = path.join(tempDir, 'malformed');
        fs.mkdirSync(wpDir);
        fs.writeFileSync(path.join(wpDir, 'project.json'), '{ invalid json ');

        const items = scanWallpapers(tempDir);
        assert.strictEqual(items.length, 0);
    });

    test('scanWallpapersWithDiagnostics should summarize available and unsupported wallpapers', () => {
        const videoDir = path.join(tempDir, 'video');
        const sceneDir = path.join(tempDir, 'scene');
        fs.mkdirSync(videoDir);
        fs.mkdirSync(sceneDir);
        fs.writeFileSync(path.join(videoDir, 'project.json'), JSON.stringify({
            title: 'Video',
            file: 'video.mp4',
            type: 'video'
        }));
        fs.writeFileSync(path.join(sceneDir, 'project.json'), JSON.stringify({
            title: 'Scene',
            file: 'scene.pkg',
            type: 'scene'
        }));

        const result = scanWallpapersWithDiagnostics(tempDir);

        assert.deepStrictEqual(result.statistics, {
            totalDirectories: 2,
            available: 2,
            corrupted: 0,
            unsupported: 0,
            permissionDenied: 0
        });
        assert.strictEqual(result.items.length, 2);
        assert.strictEqual(result.diagnostics.length, 0);
    });

    test('scanWallpapersWithDiagnostics should report malformed metadata as corrupted', () => {
        const wpDir = path.join(tempDir, 'malformed');
        fs.mkdirSync(wpDir);
        fs.writeFileSync(path.join(wpDir, 'project.json'), '{ invalid json ');

        const result = scanWallpapersWithDiagnostics(tempDir);

        assert.strictEqual(result.statistics.totalDirectories, 1);
        assert.strictEqual(result.statistics.corrupted, 1);
        assert.strictEqual(result.diagnostics.length, 1);
        assert.strictEqual(result.diagnostics[0].category, 'corrupted');
        assert.match(result.diagnostics[0].message, /project\.json/);
        assert.ok(result.diagnostics[0].cause instanceof Error);
    });

    test('scanWallpapersWithDiagnostics should report missing metadata as corrupted', () => {
        fs.mkdirSync(path.join(tempDir, 'missing-metadata'));

        const result = scanWallpapersWithDiagnostics(tempDir);

        assert.strictEqual(result.statistics.corrupted, 1);
        assert.strictEqual(result.diagnostics[0].category, 'corrupted');
        assert.match(result.diagnostics[0].message, /缺少 project\.json/);
    });

    test('scanWallpapersWithDiagnostics should emit each diagnostic to the logger', () => {
        const wpDir = path.join(tempDir, 'unsupported');
        fs.mkdirSync(wpDir);
        fs.writeFileSync(path.join(wpDir, 'project.json'), JSON.stringify({
            title: 'Unsupported',
            type: 'unknown-type'
        }));
        const loggedMessages: string[] = [];

        const result = scanWallpapersWithDiagnostics(tempDir, diagnostic => {
            loggedMessages.push(`${diagnostic.category}:${diagnostic.wallpaperId}`);
        });

        assert.strictEqual(result.statistics.unsupported, 1);
        assert.deepStrictEqual(loggedMessages, ['unsupported:unsupported']);
    });

    test('scanWallpapersWithDiagnostics should classify permission errors', () => {
        const wpDir = path.join(tempDir, 'permission-denied');
        fs.mkdirSync(wpDir);
        fs.writeFileSync(path.join(wpDir, 'project.json'), JSON.stringify({ type: 'web' }));
        const fsModule = require('fs') as typeof fs;
        const originalStatSync = fsModule.statSync;
        const deniedPath = path.join(wpDir, 'project.json');
        const deniedStatSync = ((target: fs.PathLike) => {
            if (path.resolve(target.toString()) === path.resolve(deniedPath)) {
                const error = new Error('permission denied') as NodeJS.ErrnoException;
                error.code = 'EACCES';
                throw error;
            }
            return originalStatSync(target);
        }) as typeof fs.statSync;
        Object.defineProperty(fsModule, 'statSync', { configurable: true, value: deniedStatSync });

        try {
            const result = scanWallpapersWithDiagnostics(tempDir);

            assert.strictEqual(result.statistics.permissionDenied, 1);
            assert.strictEqual(result.statistics.corrupted, 0);
            assert.strictEqual(result.diagnostics[0].category, 'permissionDenied');
            assert.ok(result.diagnostics[0].cause instanceof Error);
        } finally {
            Object.defineProperty(fsModule, 'statSync', { configurable: true, value: originalStatSync });
        }
    });
});
