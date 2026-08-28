import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { validatePlaybackDescriptor, WallpaperPlaybackDescriptor } from '../core/playback-state';
import { WallpaperType } from '../core/types';

suite('Playback State Test Suite', () => {
    let tempDir: string;
    let descriptor: WallpaperPlaybackDescriptor;

    setup(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-wallpaper-playback-'));
        const mediaPath = path.join(tempDir, 'scene.webm');
        await fs.writeFile(mediaPath, 'video');
        descriptor = {
            version: 1,
            wallpaperId: '2076546001',
            wallpaperTitle: 'hk416',
            sourceType: WallpaperType.Scene,
            rootPath: tempDir,
            mediaPath,
            entryFile: 'scene.webm',
            playbackType: WallpaperType.Video,
            location: tempDir
        };
    });

    teardown(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('accepts a valid Scene cache playback descriptor', async () => {
        assert.deepStrictEqual(await validatePlaybackDescriptor(descriptor, '2076546001'), descriptor);
    });

    test('rejects mismatched ids and entry paths', async () => {
        assert.strictEqual(await validatePlaybackDescriptor(descriptor, 'other'), undefined);
        assert.strictEqual(await validatePlaybackDescriptor({ ...descriptor, entryFile: 'other.webm' }), undefined);
    });

    test('accepts dependency media resolved through location', async () => {
        const dependencyDir = path.join(tempDir, 'dependency');
        const mediaPath = path.join(dependencyDir, 'scene.webm');
        await fs.mkdir(dependencyDir);
        await fs.writeFile(mediaPath, 'video');

        const resolved = await validatePlaybackDescriptor({
            ...descriptor,
            mediaPath,
            entryFile: 'scene.webm',
            location: dependencyDir
        });

        assert.ok(resolved);
    });

    test('rejects Scene as a direct playback type', async () => {
        assert.strictEqual(await validatePlaybackDescriptor({
            ...descriptor,
            playbackType: WallpaperType.Scene
        }), undefined);
    });
});
