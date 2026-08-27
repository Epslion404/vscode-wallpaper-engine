import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getWallpaperById, scanWallpapers } from '../core/scanner';
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

    test('scanWallpapers should ignore native scene wallpapers', () => {
        const wpDir = path.join(tempDir, 'scene-wallpaper');
        fs.mkdirSync(wpDir);
        fs.writeFileSync(path.join(wpDir, 'project.json'), JSON.stringify({
            title: 'Native Scene Wallpaper',
            file: 'scene.pkg',
            type: 'scene'
        }));

        const items = scanWallpapers(tempDir);

        assert.strictEqual(items.length, 0);
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
});
