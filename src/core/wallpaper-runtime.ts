/** 激活阶段用于判断是否需要恢复 Workbench 注入的最小状态。 */
export interface WallpaperRecoveryState {
    disabled: boolean;
    serviceHealthy: boolean;
    persistedPath?: string;
    persistedEntry?: string;
    workbenchPatched: boolean;
}

export function needsWallpaperInjection(state: WallpaperRecoveryState): boolean {
    return !state.disabled
        && state.serviceHealthy
        && Boolean(state.persistedPath)
        && Boolean(state.persistedEntry)
        && !state.workbenchPatched;
}
