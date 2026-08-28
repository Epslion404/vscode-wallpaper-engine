import * as fs from 'fs/promises';
import * as path from 'path';
import { runSceneProcess } from './scene-process';

export interface SceneExecutables {
    wallpaperEnginePath: string;
    ffmpegPath: string;
}

export interface SceneDependencyOptions {
    configuredWallpaperEnginePath: string;
    configuredFfmpegPath: string;
    workshopPath: string;
}

async function isFile(candidate: string): Promise<boolean> {
    try {
        return (await fs.stat(candidate)).isFile();
    } catch {
        return false;
    }
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values.filter(value => value.length > 0))];
}

function wallpaperEngineCandidates(options: SceneDependencyOptions): string[] {
    const steamAppsPath = path.resolve(options.workshopPath, '..', '..', '..');
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    return unique([
        options.configuredWallpaperEnginePath,
        path.join(steamAppsPath, 'common', 'wallpaper_engine', 'wallpaper64.exe'),
        path.join(steamAppsPath, 'common', 'wallpaper_engine', 'wallpaper32.exe'),
        ...(programFilesX86 ? [
            path.join(programFilesX86, 'Steam', 'steamapps', 'common', 'wallpaper_engine', 'wallpaper64.exe'),
            path.join(programFilesX86, 'Steam', 'steamapps', 'common', 'wallpaper_engine', 'wallpaper32.exe')
        ] : [])
    ]);
}

function ffmpegCandidates(configuredPath: string): string[] {
    const systemDrive = process.env.SystemDrive || 'C:';
    return unique([
        configuredPath,
        'ffmpeg',
        path.join(systemDrive, 'ffmpeg', 'bin', 'ffmpeg.exe')
    ]);
}

export async function validateWallpaperEngineExecutable(candidate: string): Promise<boolean> {
    const baseName = path.basename(candidate).toLowerCase();
    return (baseName === 'wallpaper64.exe' || baseName === 'wallpaper32.exe') && isFile(candidate);
}

export async function validateFfmpegExecutable(candidate: string): Promise<boolean> {
    try {
        if (path.isAbsolute(candidate) && !await isFile(candidate)) {
            return false;
        }
        const [devices, encoders] = await Promise.all([
            runSceneProcess(candidate, ['-hide_banner', '-devices'], { timeoutMs: 5000 }),
            runSceneProcess(candidate, ['-hide_banner', '-encoders'], { timeoutMs: 5000 })
        ]);
        const deviceOutput = `${devices.stdout}\n${devices.stderr}`;
        const encoderOutput = `${encoders.stdout}\n${encoders.stderr}`;
        return devices.exitCode === 0
            && encoders.exitCode === 0
            && /\bgdigrab\b/i.test(deviceOutput)
            && /\blibvpx-vp9\b/i.test(encoderOutput);
    } catch {
        return false;
    }
}

export async function detectSceneExecutables(options: SceneDependencyOptions): Promise<Partial<SceneExecutables>> {
    let wallpaperEnginePath: string | undefined;
    for (const candidate of wallpaperEngineCandidates(options)) {
        if (await validateWallpaperEngineExecutable(candidate)) {
            wallpaperEnginePath = candidate;
            break;
        }
    }

    let ffmpegPath: string | undefined;
    for (const candidate of ffmpegCandidates(options.configuredFfmpegPath)) {
        if (await validateFfmpegExecutable(candidate)) {
            ffmpegPath = candidate;
            break;
        }
    }
    return { wallpaperEnginePath, ffmpegPath };
}
