import * as fs from 'fs/promises';
import * as path from 'path';
import { PlayableWallpaperType, WallpaperType } from './types';

export const CURRENT_PLAYBACK_STATE_KEY = 'currentWallpaperPlayback';

export interface WallpaperPlaybackDescriptor {
    version: 1;
    wallpaperId: string;
    wallpaperTitle: string;
    sourceType: WallpaperType;
    rootPath: string;
    mediaPath: string;
    entryFile: string;
    playbackType: PlayableWallpaperType;
    location?: string;
}

function isPlayableWallpaperType(value: unknown): value is PlayableWallpaperType {
    return value === WallpaperType.Video || value === WallpaperType.Image || value === WallpaperType.Web;
}

function isWallpaperType(value: unknown): value is WallpaperType {
    return Object.values(WallpaperType).includes(value as WallpaperType);
}

export function isWallpaperPlaybackDescriptor(value: unknown): value is WallpaperPlaybackDescriptor {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return candidate.version === 1
        && typeof candidate.wallpaperId === 'string'
        && candidate.wallpaperId.length > 0
        && typeof candidate.wallpaperTitle === 'string'
        && isWallpaperType(candidate.sourceType)
        && typeof candidate.rootPath === 'string'
        && candidate.rootPath.length > 0
        && typeof candidate.mediaPath === 'string'
        && candidate.mediaPath.length > 0
        && typeof candidate.entryFile === 'string'
        && candidate.entryFile.length > 0
        && isPlayableWallpaperType(candidate.playbackType)
        && (candidate.location === undefined || typeof candidate.location === 'string');
}

export async function validatePlaybackDescriptor(
    value: unknown,
    expectedWallpaperId?: string
): Promise<WallpaperPlaybackDescriptor | undefined> {
    if (!isWallpaperPlaybackDescriptor(value)
        || (expectedWallpaperId !== undefined && value.wallpaperId !== expectedWallpaperId)) {
        return undefined;
    }
    try {
        const [rootStat, mediaStat] = await Promise.all([
            fs.stat(value.rootPath),
            fs.stat(value.mediaPath)
        ]);
        if (!rootStat.isDirectory() || !mediaStat.isFile()) {
            return undefined;
        }
        const expectedEntryPath = path.resolve(value.location ?? value.rootPath, value.entryFile);
        if (expectedEntryPath !== path.resolve(value.mediaPath)) {
            return undefined;
        }
        return value;
    } catch {
        return undefined;
    }
}
