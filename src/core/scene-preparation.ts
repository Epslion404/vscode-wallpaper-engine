import * as path from 'path';
import { SceneCacheEntry } from './scene-cache';
import { WallpaperPlaybackDescriptor } from './playback-state';
import { WallpaperItem } from './scanner';
import { WallpaperType } from './types';

function wallpaperTitle(item: WallpaperItem): string {
    return item.label.replace(/^\$\([^)]*\)\s*/, '');
}

export function createDirectPlaybackDescriptor(item: WallpaperItem): WallpaperPlaybackDescriptor {
    const media = item.getMediaPath();
    return {
        version: 1,
        wallpaperId: item.id,
        wallpaperTitle: wallpaperTitle(item),
        sourceType: item.type,
        rootPath: item.dirPath,
        mediaPath: media.path,
        entryFile: path.basename(media.path),
        playbackType: media.type,
        location: item.location
    };
}

export function createScenePlaybackDescriptor(
    item: WallpaperItem,
    cache: SceneCacheEntry
): WallpaperPlaybackDescriptor {
    if (item.type !== WallpaperType.Scene || cache.manifest.wallpaperId !== item.id) {
        throw new Error('Scene 缓存与所选壁纸不匹配');
    }
    return {
        version: 1,
        wallpaperId: item.id,
        wallpaperTitle: wallpaperTitle(item),
        sourceType: WallpaperType.Scene,
        rootPath: cache.cacheDir,
        mediaPath: cache.videoPath,
        entryFile: path.basename(cache.videoPath),
        playbackType: WallpaperType.Video,
        location: cache.cacheDir
    };
}
