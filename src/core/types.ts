export enum WallpaperType {
    Video = 'video',
    Image = 'image',
    Web = 'web',
    Scene = 'scene'
}

export type PlayableWallpaperType = WallpaperType.Video | WallpaperType.Image | WallpaperType.Web;
