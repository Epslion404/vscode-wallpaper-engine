import * as assert from 'assert';
import {
    buildCloseWallpaperArgs,
    buildFfmpegRecordingArgs,
    buildFfmpegTranscodeArgs,
    buildOpenWallpaperArgs,
    createSceneWindowName,
    runSceneProcess,
    SceneRecordingError
} from '../core/scene-recorder';
import { SceneRecordingProfile, SceneSource } from '../core/scene-cache';

suite('Scene Recorder Test Suite', () => {
    const source: SceneSource = {
        wallpaperId: '2076546001',
        projectJsonPath: 'D:\\Workshop\\2076546001\\project.json',
        sourcePath: 'D:\\Workshop\\2076546001\\scene.pkg'
    };
    const profile: SceneRecordingProfile = {
        durationSeconds: 30,
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'libvpx-vp9'
    };

    test('builds a unique named Wallpaper Engine window command', () => {
        const windowName = createSceneWindowName(source.wallpaperId, 'operation-1');
        const args = buildOpenWallpaperArgs(source, profile, windowName);

        assert.match(windowName, /2076546001 operation-1/);
        assert.deepStrictEqual(args.slice(0, 6), [
            '-control', 'openWallpaper',
            '-file', source.projectJsonPath,
            '-playInWindow', windowName
        ]);
        assert.deepStrictEqual(buildCloseWallpaperArgs(windowName), [
            '-control', 'closeWallpaper', '-location', windowName
        ]);
    });

    test('builds gdigrab VP9 WebM recording arguments without a shell string', () => {
        const args = buildFfmpegRecordingArgs(profile, 'capture-window', 'cache.recording');

        assert.deepStrictEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', 'gdigrab']);
        assert.ok(args.includes('title=capture-window'));
        assert.ok(args.includes('libvpx-vp9'));
        assert.ok(args.includes('webm'));
        assert.strictEqual(args.at(-1), 'cache.recording');
    });

    test('builds a fixed-size 30 FPS VP9 transcode for WGC output', () => {
        const args = buildFfmpegTranscodeArgs(profile, 'capture.mp4', 'cache.recording');
        const filter = args[args.indexOf('-vf') + 1];

        assert.match(filter, /crop=/);
        assert.match(filter, /scale=1920:1080/);
        assert.match(filter, /fps=30/);
        assert.ok(args.includes('libvpx-vp9'));
        assert.strictEqual(args.at(-1), 'cache.recording');
    });

    test('cancels a running child process', async () => {
        const controller = new AbortController();
        const result = runSceneProcess(
            process.execPath,
            ['-e', 'setInterval(() => undefined, 1000)'],
            { signal: controller.signal, timeoutMs: 5000 }
        );
        setTimeout(() => controller.abort(), 50);

        await assert.rejects(result, error =>
            error instanceof SceneRecordingError && error.code === 'cancelled'
        );
    });

    test('times out a child process that does not exit', async () => {
        await assert.rejects(
            runSceneProcess(
                process.execPath,
                ['-e', 'setInterval(() => undefined, 1000)'],
                { timeoutMs: 50 }
            ),
            /进程运行超时/
        );
    });
});
