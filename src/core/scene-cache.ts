import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export const DEFAULT_SCENE_RECORDING_SECONDS = 30;
export const MIN_SCENE_RECORDING_SECONDS = 1;
export const MAX_SCENE_RECORDING_SECONDS = 300;

export interface SceneSource {
    wallpaperId: string;
    projectJsonPath: string;
    sourcePath: string;
}

export interface SceneRecordingProfile {
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
    codec: 'libvpx-vp9';
}

export interface SceneSourceFingerprint {
    projectSize: number;
    projectMtimeMs: number;
    sourceSize: number;
    sourceMtimeMs: number;
}

export interface SceneCacheManifest {
    version: 1;
    wallpaperId: string;
    cacheKey: string;
    source: SceneSourceFingerprint;
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
    codec: 'libvpx-vp9';
    createdAt: string;
    outputFileName: string;
}

export interface SceneCacheEntry {
    manifest: SceneCacheManifest;
    videoPath: string;
    cacheDir: string;
}

export interface SceneCacheTarget {
    cacheDir: string;
    cacheKey: string;
    manifestPath: string;
    temporaryVideoPath: string;
    finalVideoPath: string;
    manifest: SceneCacheManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isSourceFingerprint(value: unknown): value is SceneSourceFingerprint {
    return isRecord(value)
        && isFiniteNonNegativeNumber(value.projectSize)
        && isFiniteNonNegativeNumber(value.projectMtimeMs)
        && isFiniteNonNegativeNumber(value.sourceSize)
        && isFiniteNonNegativeNumber(value.sourceMtimeMs);
}

export function isSceneCacheManifest(value: unknown): value is SceneCacheManifest {
    return isRecord(value)
        && value.version === 1
        && typeof value.wallpaperId === 'string'
        && value.wallpaperId.length > 0
        && typeof value.cacheKey === 'string'
        && value.cacheKey.length > 0
        && isSourceFingerprint(value.source)
        && isPositiveInteger(value.durationSeconds)
        && isPositiveInteger(value.width)
        && isPositiveInteger(value.height)
        && isPositiveInteger(value.fps)
        && value.codec === 'libvpx-vp9'
        && typeof value.createdAt === 'string'
        && !Number.isNaN(Date.parse(value.createdAt))
        && typeof value.outputFileName === 'string'
        && /^[a-zA-Z0-9._-]+\.webm$/.test(value.outputFileName);
}

export function parseSceneRecordingDuration(value: string): number | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return DEFAULT_SCENE_RECORDING_SECONDS;
    }
    if (!/^\d+$/.test(trimmed)) {
        return undefined;
    }
    const duration = Number(trimmed);
    return Number.isSafeInteger(duration)
        && duration >= MIN_SCENE_RECORDING_SECONDS
        && duration <= MAX_SCENE_RECORDING_SECONDS
        ? duration
        : undefined;
}

export function isPathInside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateWallpaperId(wallpaperId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(wallpaperId)) {
        throw new Error('Scene 壁纸 ID 包含非法字符');
    }
}

export async function createSceneSourceFingerprint(source: SceneSource): Promise<SceneSourceFingerprint> {
    const [projectStat, sourceStat] = await Promise.all([
        fs.stat(source.projectJsonPath),
        fs.stat(source.sourcePath)
    ]);
    if (!projectStat.isFile()) {
        throw new Error('Scene project.json 不是文件');
    }
    if (!sourceStat.isFile()) {
        throw new Error('Scene 入口资源不是文件');
    }
    return {
        projectSize: projectStat.size,
        projectMtimeMs: projectStat.mtimeMs,
        sourceSize: sourceStat.size,
        sourceMtimeMs: sourceStat.mtimeMs
    };
}

export function createSceneCacheKey(
    source: SceneSource,
    fingerprint: SceneSourceFingerprint,
    profile: SceneRecordingProfile
): string {
    const value = JSON.stringify({
        wallpaperId: source.wallpaperId,
        fingerprint,
        durationSeconds: profile.durationSeconds,
        width: profile.width,
        height: profile.height,
        fps: profile.fps,
        codec: profile.codec
    });
    return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function fingerprintsEqual(left: SceneSourceFingerprint, right: SceneSourceFingerprint): boolean {
    return left.projectSize === right.projectSize
        && left.projectMtimeMs === right.projectMtimeMs
        && left.sourceSize === right.sourceSize
        && left.sourceMtimeMs === right.sourceMtimeMs;
}

async function readCacheEntry(
    cacheDir: string,
    manifestPath: string,
    wallpaperId: string,
    sourceFingerprint: SceneSourceFingerprint
): Promise<SceneCacheEntry | undefined> {
    try {
        const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (!isSceneCacheManifest(parsed)
            || parsed.wallpaperId !== wallpaperId
            || !fingerprintsEqual(parsed.source, sourceFingerprint)) {
            return undefined;
        }
        const videoPath = path.resolve(cacheDir, parsed.outputFileName);
        if (!isPathInside(cacheDir, videoPath)) {
            return undefined;
        }
        const stat = await fs.stat(videoPath);
        if (!stat.isFile() || stat.size < 4096) {
            return undefined;
        }
        return { manifest: parsed, videoPath, cacheDir };
    } catch {
        // 缓存属于外部持久化数据，损坏时按未命中处理并允许重新录制。
        return undefined;
    }
}

export async function findLatestValidSceneCache(
    cacheRoot: string,
    source: SceneSource
): Promise<SceneCacheEntry | undefined> {
    validateWallpaperId(source.wallpaperId);
    const cacheDir = path.join(cacheRoot, source.wallpaperId);
    if (!isPathInside(cacheRoot, cacheDir)) {
        throw new Error('Scene 缓存目录超出扩展存储范围');
    }
    const sourceFingerprint = await createSceneSourceFingerprint(source);
    let fileNames: string[];
    try {
        fileNames = await fs.readdir(cacheDir);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
    const entries = await Promise.all(fileNames
        .filter(fileName => fileName.endsWith('.json'))
        .map(fileName => readCacheEntry(cacheDir, path.join(cacheDir, fileName), source.wallpaperId, sourceFingerprint)));
    return entries
        .filter((entry): entry is SceneCacheEntry => entry !== undefined)
        .sort((left, right) => Date.parse(right.manifest.createdAt) - Date.parse(left.manifest.createdAt))[0];
}

export async function createSceneCacheTarget(
    cacheRoot: string,
    source: SceneSource,
    profile: SceneRecordingProfile,
    operationId: string,
    now = new Date()
): Promise<SceneCacheTarget> {
    validateWallpaperId(source.wallpaperId);
    const fingerprint = await createSceneSourceFingerprint(source);
    const cacheKey = createSceneCacheKey(source, fingerprint, profile);
    const cacheDir = path.join(cacheRoot, source.wallpaperId);
    if (!isPathInside(cacheRoot, cacheDir)) {
        throw new Error('Scene 缓存目录超出扩展存储范围');
    }
    await fs.mkdir(cacheDir, { recursive: true });
    const safeOperationId = operationId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const outputFileName = `${cacheKey}-${safeOperationId}.webm`;
    return {
        cacheDir,
        cacheKey,
        manifestPath: path.join(cacheDir, `${cacheKey}-${safeOperationId}.json`),
        temporaryVideoPath: path.join(cacheDir, `.${outputFileName}.recording`),
        finalVideoPath: path.join(cacheDir, outputFileName),
        manifest: {
            version: 1,
            wallpaperId: source.wallpaperId,
            cacheKey,
            source: fingerprint,
            durationSeconds: profile.durationSeconds,
            width: profile.width,
            height: profile.height,
            fps: profile.fps,
            codec: profile.codec,
            createdAt: now.toISOString(),
            outputFileName
        }
    };
}

export async function commitSceneCache(target: SceneCacheTarget): Promise<SceneCacheEntry> {
    const videoStat = await fs.stat(target.temporaryVideoPath);
    if (!videoStat.isFile() || videoStat.size < 4096) {
        throw new Error('Scene 录制文件为空或过小');
    }

    const temporaryManifestPath = `${target.manifestPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryManifestPath, JSON.stringify(target.manifest, null, 2), 'utf8');
    try {
        await fs.rename(target.temporaryVideoPath, target.finalVideoPath);
        await fs.rename(temporaryManifestPath, target.manifestPath);
    } catch (error) {
        await Promise.allSettled([
            fs.rm(temporaryManifestPath, { force: true }),
            fs.rm(target.finalVideoPath, { force: true })
        ]);
        throw error;
    }

    // 新缓存提交后再删除同参数旧版本，重录失败时旧缓存始终保持可用。
    const manifestNames = await fs.readdir(target.cacheDir);
    await Promise.allSettled(manifestNames
        .filter(name => name.endsWith('.json') && path.join(target.cacheDir, name) !== target.manifestPath)
        .map(async name => {
            const manifestPath = path.join(target.cacheDir, name);
            try {
                const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
                if (!isSceneCacheManifest(parsed)
                    || parsed.cacheKey !== target.cacheKey
                    || Date.parse(parsed.createdAt) > Date.parse(target.manifest.createdAt)) {
                    return;
                }
                const videoPath = path.join(target.cacheDir, parsed.outputFileName);
                await Promise.all([
                    fs.rm(manifestPath, { force: true }),
                    isPathInside(target.cacheDir, videoPath)
                        ? fs.rm(videoPath, { force: true })
                        : Promise.resolve()
                ]);
            } catch {
                // 无法解析的清单留给后续缓存管理处理，不能影响已完成的新录制。
            }
        }));
    return { manifest: target.manifest, videoPath: target.finalVideoPath, cacheDir: target.cacheDir };
}

export async function removeTemporarySceneCache(target: SceneCacheTarget): Promise<void> {
    await fs.rm(target.temporaryVideoPath, { force: true });
}
