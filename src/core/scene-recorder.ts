import * as fs from 'fs/promises';
import * as path from 'path';
import {
    commitSceneCache,
    createSceneCacheTarget,
    removeTemporarySceneCache,
    SceneCacheEntry,
    SceneRecordingProfile,
    SceneSource
} from './scene-cache';
import { SceneExecutables } from './scene-dependencies';
import { runSceneProcess, SceneRecordingError } from './scene-process';

const WINDOW_READY_TIMEOUT_MS = 15_000;
const WINDOW_POLL_INTERVAL_MS = 500;
const WINDOW_WARMUP_MS = 1_500;

export type SceneRecordingStage = 'launch' | 'waitWindow' | 'record' | 'validate' | 'cleanup';

export interface SceneRecorderLogger {
    info(message: string): void;
    error(message: string, error: unknown): void;
}

export interface SceneRecordingProgress {
    stage: SceneRecordingStage;
    message: string;
    elapsedSeconds?: number;
    totalSeconds?: number;
}

export interface RecordSceneOptions {
    source: SceneSource;
    profile: SceneRecordingProfile;
    executables: SceneExecutables;
    cacheRoot: string;
    captureHelperPath: string;
    operationId: string;
    signal?: AbortSignal;
    report?(progress: SceneRecordingProgress): void;
    logger: SceneRecorderLogger;
}

export { SceneRecordingError, runSceneProcess } from './scene-process';

export function createSceneWindowName(wallpaperId: string, operationId: string): string {
    return `VWE Scene Capture ${wallpaperId} ${operationId}`;
}

export function buildOpenWallpaperArgs(
    source: SceneSource,
    profile: SceneRecordingProfile,
    windowName: string
): string[] {
    return [
        '-control', 'openWallpaper',
        '-file', source.projectJsonPath,
        '-playInWindow', windowName,
        '-width', String(profile.width),
        '-height', String(profile.height),
        '-activate',
        '-borderless'
    ];
}

export function buildCloseWallpaperArgs(windowName: string): string[] {
    return ['-control', 'closeWallpaper', '-location', windowName];
}

export function buildFfmpegRecordingArgs(
    profile: SceneRecordingProfile,
    windowName: string,
    outputPath: string
): string[] {
    return [
        '-y',
        '-hide_banner',
        '-f', 'gdigrab',
        '-framerate', String(profile.fps),
        '-draw_mouse', '0',
        '-i', `title=${windowName}`,
        '-t', String(profile.durationSeconds),
        '-an',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', profile.codec,
        '-preset', 'veryfast',
        '-tune', 'animation',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-f', 'mp4',
        outputPath
    ];
}

export function buildFfmpegTranscodeArgs(
    profile: SceneRecordingProfile,
    inputPath: string,
    outputPath: string
): string[] {
    const cropWidth = `min(iw\\,${profile.width})`;
    const cropHeight = `min(ih\\,${profile.height})`;
    const filter = [
        `crop=${cropWidth}:${cropHeight}:(iw-${cropWidth})/2:(ih-${cropHeight})/2`,
        `scale=${profile.width}:${profile.height}`,
        `fps=${profile.fps}`
    ].join(',');
    return [
        '-y',
        '-hide_banner',
        '-i', inputPath,
        '-an',
        '-vf', filter,
        '-c:v', profile.codec,
        '-preset', 'veryfast',
        '-tune', 'animation',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-f', 'mp4',
        outputPath
    ];
}

function isAbortError(error: unknown): boolean {
    return error instanceof SceneRecordingError && error.code === 'cancelled';
}

async function isFile(candidate: string): Promise<boolean> {
    try {
        return (await fs.stat(candidate)).isFile();
    } catch {
        return false;
    }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(new SceneRecordingError('cancelled', 'Scene 录制已取消'));
    }
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timeout);
            reject(new SceneRecordingError('cancelled', 'Scene 录制已取消'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

async function sendWallpaperControl(
    executable: string,
    args: readonly string[],
    signal?: AbortSignal
): Promise<void> {
    const result = await runSceneProcess(executable, args, { signal, timeoutMs: 10_000 });
    if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `Wallpaper Engine 控制命令退出码 ${result.exitCode}`);
    }
}

async function closeWallpaperWindow(executable: string, windowName: string): Promise<void> {
    await sendWallpaperControl(executable, buildCloseWallpaperArgs(windowName));
}

async function waitForCaptureWindow(
    ffmpegPath: string,
    windowName: string,
    signal: AbortSignal | undefined,
    logger: SceneRecorderLogger
): Promise<void> {
    const startedAt = Date.now();
    let lastError = '';
    while (Date.now() - startedAt < WINDOW_READY_TIMEOUT_MS) {
        const result = await runSceneProcess(ffmpegPath, [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'gdigrab',
            '-framerate', '1',
            '-draw_mouse', '0',
            '-i', `title=${windowName}`,
            '-frames:v', '1',
            '-f', 'null', '-'
        ], { signal, timeoutMs: 3000 });
        if (result.exitCode === 0) {
            logger.info(`已发现 Scene 渲染窗口，等待 ${WINDOW_WARMUP_MS}ms 预热`);
            await wait(WINDOW_WARMUP_MS, signal);
            return;
        }
        lastError = result.stderr.trim();
        await wait(WINDOW_POLL_INTERVAL_MS, signal);
    }
    throw new SceneRecordingError(
        'window',
        `等待 Wallpaper Engine 渲染窗口超时${lastError ? `：${lastError}` : ''}`
    );
}

function parseRecordedDuration(output: string): number | undefined {
    const match = output.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
    if (!match) {
        return undefined;
    }
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function maxBlackDuration(output: string): number {
    const matches = [...output.matchAll(/black_duration:([0-9.]+)/g)];
    return matches.reduce((maximum, match) => Math.max(maximum, Number(match[1])), 0);
}

async function validateRecording(
    ffmpegPath: string,
    videoPath: string,
    expectedDurationSeconds: number,
    signal?: AbortSignal
): Promise<void> {
    const result = await runSceneProcess(ffmpegPath, [
        '-hide_banner',
        '-i', videoPath,
        '-vf', 'blackdetect=d=1:pic_th=0.98:pix_th=0.02',
        '-an',
        '-f', 'null', '-'
    ], { signal, timeoutMs: Math.max(15_000, expectedDurationSeconds * 2000) });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0 || !/Video:\s*h264\b/i.test(output)) {
        throw new SceneRecordingError('capture', '录制结果不包含可用的 H.264 视频流');
    }
    const actualDuration = parseRecordedDuration(output);
    const minimumDuration = Math.max(0.5, expectedDurationSeconds - 2);
    if (actualDuration === undefined || actualDuration < minimumDuration) {
        throw new SceneRecordingError('capture', '录制结果时长不足');
    }
    if (maxBlackDuration(output) >= actualDuration - 0.5) {
        throw new SceneRecordingError('blackFrames', '录制结果持续为黑帧，当前显卡环境可能不支持窗口捕获');
    }
}

export async function recordSceneToCache(options: RecordSceneOptions): Promise<SceneCacheEntry> {
    const target = await createSceneCacheTarget(
        options.cacheRoot,
        options.source,
        options.profile,
        options.operationId
    );
    const windowName = createSceneWindowName(options.source.wallpaperId, options.operationId);
    const intermediateCapturePath = path.join(target.cacheDir, `.${target.cacheKey}-${options.operationId}.capture.mp4`);
    let elapsedTimer: NodeJS.Timeout | undefined;
    const startedAt = Date.now();
    const report = (progress: SceneRecordingProgress): void => {
        options.report?.(progress);
        options.logger.info(progress.message);
    };

    try {
        report({ stage: 'launch', message: '正在启动 Wallpaper Engine Scene 渲染窗口…' });
        await closeWallpaperWindow(options.executables.wallpaperEnginePath, windowName).catch(() => undefined);
        await sendWallpaperControl(
            options.executables.wallpaperEnginePath,
            buildOpenWallpaperArgs(options.source, options.profile, windowName),
            options.signal
        );

        report({ stage: 'waitWindow', message: '正在等待 Scene 渲染窗口…' });
        await waitForCaptureWindow(
            options.executables.ffmpegPath,
            windowName,
            options.signal,
            options.logger
        );

        report({
            stage: 'record',
            message: `正在录制 0/${options.profile.durationSeconds} 秒…`,
            elapsedSeconds: 0,
            totalSeconds: options.profile.durationSeconds
        });
        const recordingStartedAt = Date.now();
        elapsedTimer = setInterval(() => {
            const elapsedSeconds = Math.min(
                options.profile.durationSeconds,
                Math.floor((Date.now() - recordingStartedAt) / 1000)
            );
            options.report?.({
                stage: 'record',
                message: `正在录制 ${elapsedSeconds}/${options.profile.durationSeconds} 秒…`,
                elapsedSeconds,
                totalSeconds: options.profile.durationSeconds
            });
        }, 1000);

        const helperAvailable = await isFile(options.captureHelperPath);
        const recordingResult = helperAvailable
            ? await runSceneProcess(options.captureHelperPath, [
                windowName,
                String(options.profile.durationSeconds * 1000),
                intermediateCapturePath
            ], {
                signal: options.signal,
                timeoutMs: (options.profile.durationSeconds + 15) * 1000
            })
            : await runSceneProcess(
                options.executables.ffmpegPath,
                buildFfmpegRecordingArgs(options.profile, windowName, target.temporaryVideoPath),
                {
                    signal: options.signal,
                    timeoutMs: (options.profile.durationSeconds + 15) * 1000
                }
            );
        if (recordingResult.exitCode !== 0) {
            const captureTool = helperAvailable ? 'Scene 捕获 helper' : 'FFmpeg';
            throw new SceneRecordingError(
                'capture',
                recordingResult.stderr.trim() || `${captureTool} 退出码 ${recordingResult.exitCode}`
            );
        }
        if (elapsedTimer) {
            clearInterval(elapsedTimer);
            elapsedTimer = undefined;
        }

        if (helperAvailable) {
            // 录制完成后立即关闭渲染窗口，避免与 H.264 转码同时占用 GPU。
            await closeWallpaperWindow(options.executables.wallpaperEnginePath, windowName).catch(error => {
                options.logger.error('提前关闭 Scene 渲染窗口失败', error);
            });
            report({ stage: 'validate', message: '正在将 Scene 录制转换为 H.264/MP4…' });
            const transcodeResult = await runSceneProcess(
                options.executables.ffmpegPath,
                buildFfmpegTranscodeArgs(options.profile, intermediateCapturePath, target.temporaryVideoPath),
                {
                    signal: options.signal,
                    timeoutMs: Math.max(30_000, options.profile.durationSeconds * 5000)
                }
            );
            if (transcodeResult.exitCode !== 0) {
                throw new SceneRecordingError(
                    'capture',
                    transcodeResult.stderr.trim() || `FFmpeg 转码退出码 ${transcodeResult.exitCode}`
                );
            }
        }

        report({ stage: 'validate', message: '正在验证 Scene 视频缓存…' });
        await validateRecording(
            options.executables.ffmpegPath,
            target.temporaryVideoPath,
            options.profile.durationSeconds,
            options.signal
        );
        const entry = await commitSceneCache(target);
        options.logger.info(`Scene 缓存已生成，耗时 ${Date.now() - startedAt}ms`);
        return entry;
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        if (error instanceof SceneRecordingError) {
            throw error;
        }
        throw new SceneRecordingError('capture', 'Scene 录制失败', { cause: error });
    } finally {
        if (elapsedTimer) {
            clearInterval(elapsedTimer);
        }
        report({ stage: 'cleanup', message: '正在清理 Scene 录制窗口与临时文件…' });
        await Promise.allSettled([
            closeWallpaperWindow(options.executables.wallpaperEnginePath, windowName),
            removeTemporarySceneCache(target),
            fs.rm(intermediateCapturePath, { force: true })
        ]).then(results => {
            const closeResult = results[0];
            if (closeResult.status === 'rejected') {
                options.logger.error('关闭 Scene 渲染窗口失败', closeResult.reason);
            }
        });
    }
}
