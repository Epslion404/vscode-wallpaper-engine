import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    commitSceneCache,
    createSceneCacheTarget,
    createSceneSourceFingerprint,
    DEFAULT_SCENE_RECORDING_SECONDS,
    findLatestValidSceneCache,
    isSceneCacheManifest,
    parseSceneRecordingDuration,
    SceneRecordingProfile,
    SceneSource
} from '../core/scene-cache';

suite('Scene Cache Test Suite', () => {
    let tempDir: string;
    let source: SceneSource;
    const profile: SceneRecordingProfile = {
        durationSeconds: 30,
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'libx264'
    };

    setup(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-wallpaper-scene-cache-'));
        const sourceDir = path.join(tempDir, 'workshop', '2076546001');
        await fs.mkdir(sourceDir, { recursive: true });
        source = {
            wallpaperId: '2076546001',
            projectJsonPath: path.join(sourceDir, 'project.json'),
            sourcePath: path.join(sourceDir, 'scene.pkg')
        };
        await Promise.all([
            fs.writeFile(source.projectJsonPath, JSON.stringify({ type: 'scene' })),
            fs.writeFile(source.sourcePath, 'scene package')
        ]);
    });

    teardown(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('parseSceneRecordingDuration applies default and validates range', () => {
        assert.strictEqual(parseSceneRecordingDuration(''), DEFAULT_SCENE_RECORDING_SECONDS);
        assert.strictEqual(parseSceneRecordingDuration('  '), DEFAULT_SCENE_RECORDING_SECONDS);
        assert.strictEqual(parseSceneRecordingDuration('1'), 1);
        assert.strictEqual(parseSceneRecordingDuration('300'), 300);
        for (const invalid of ['0', '301', '-1', '1.5', 'abc']) {
            assert.strictEqual(parseSceneRecordingDuration(invalid), undefined, invalid);
        }
    });

    test('accepts only the H.264 MP4 cache contract used by Workbench playback', () => {
        const common = {
            wallpaperId: '2076546001',
            cacheKey: 'cache-key',
            source: {
                projectSize: 10,
                projectMtimeMs: 20,
                sourceSize: 30,
                sourceMtimeMs: 40
            },
            durationSeconds: 30,
            width: 1920,
            height: 1080,
            fps: 30,
            createdAt: '2026-08-29T00:00:00.000Z'
        };

        assert.strictEqual(isSceneCacheManifest({
            ...common,
            version: 2,
            codec: 'libx264',
            outputFileName: 'cache.mp4'
        }), true);
        assert.strictEqual(isSceneCacheManifest({
            ...common,
            version: 1,
            codec: 'libvpx-vp9',
            outputFileName: 'cache.webm'
        }), false);
    });

    test('commits and finds a valid cache entry', async () => {
        const cacheRoot = path.join(tempDir, 'cache');
        const target = await createSceneCacheTarget(cacheRoot, source, profile, 'operation-1');
        await fs.writeFile(target.temporaryVideoPath, Buffer.alloc(8192, 1));

        const committed = await commitSceneCache(target);
        const found = await findLatestValidSceneCache(cacheRoot, source);

        assert.strictEqual(found?.videoPath, committed.videoPath);
        assert.strictEqual(found?.manifest.durationSeconds, 30);
        assert.strictEqual(found?.manifest.codec, 'libx264');
        assert.match(found?.manifest.outputFileName ?? '', /\.mp4$/);
    });

    test('source changes invalidate an existing cache', async () => {
        const cacheRoot = path.join(tempDir, 'cache');
        const target = await createSceneCacheTarget(cacheRoot, source, profile, 'operation-1');
        await fs.writeFile(target.temporaryVideoPath, Buffer.alloc(8192, 1));
        await commitSceneCache(target);

        await fs.appendFile(source.sourcePath, 'changed');

        assert.strictEqual(await findLatestValidSceneCache(cacheRoot, source), undefined);
    });

    test('fingerprint rejects a missing scene source', async () => {
        await fs.rm(source.sourcePath);
        await assert.rejects(createSceneSourceFingerprint(source), /ENOENT/);
    });

    test('rejects wallpaper ids that could escape the cache root', async () => {
        await assert.rejects(
            createSceneCacheTarget(path.join(tempDir, 'cache'), { ...source, wallpaperId: '..' }, profile, 'operation'),
            /ID 包含非法字符/
        );
    });
});
