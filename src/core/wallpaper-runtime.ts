import * as path from 'path';

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

export interface UninstallSupersessionState {
    uninstallCreatedAt: number;
    setupCreatedAt: number;
    setupWallpaperId: string;
    currentWallpaperId: string;
    setupPath: string;
    persistedPath?: string;
    setupEntry: string;
    persistedEntry?: string;
}

export interface PendingSetupState {
    operationId: string;
    wallpaperId: string;
    wallpaperTitle: string;
    dirPath: string;
    fileName: string;
    createdAt: number;
}

export function isPendingSetupState(value: unknown): value is PendingSetupState {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Partial<PendingSetupState>;
    return typeof candidate.operationId === 'string'
        && candidate.operationId.length > 0
        && typeof candidate.wallpaperId === 'string'
        && candidate.wallpaperId.length > 0
        && typeof candidate.wallpaperTitle === 'string'
        && typeof candidate.dirPath === 'string'
        && candidate.dirPath.length > 0
        && typeof candidate.fileName === 'string'
        && candidate.fileName.length > 0
        && typeof candidate.createdAt === 'number'
        && Number.isFinite(candidate.createdAt);
}

export type UninstallSupersessionDecision =
    | { superseded: true; reason: 'newer-matching-setup' }
    | { superseded: false; reason: 'setup-not-newer' | 'wallpaper-id-mismatch' | 'persisted-path-mismatch' | 'persisted-entry-mismatch' };

/**
 * 判断较新的设置事务是否已经取代旧还原事务。
 * 只有时间、壁纸 ID、目录和入口全部一致时才允许迁移，避免把真实还原失败静默忽略。
 */
export function evaluateUninstallSupersession(state: UninstallSupersessionState): UninstallSupersessionDecision {
    if (!Number.isFinite(state.uninstallCreatedAt)
        || !Number.isFinite(state.setupCreatedAt)
        || state.setupCreatedAt <= state.uninstallCreatedAt) {
        return { superseded: false, reason: 'setup-not-newer' };
    }
    if (state.setupWallpaperId !== state.currentWallpaperId) {
        return { superseded: false, reason: 'wallpaper-id-mismatch' };
    }
    if (!state.persistedPath || normalizePath(state.setupPath) !== normalizePath(state.persistedPath)) {
        return { superseded: false, reason: 'persisted-path-mismatch' };
    }
    if (!state.persistedEntry || state.setupEntry !== state.persistedEntry) {
        return { superseded: false, reason: 'persisted-entry-mismatch' };
    }
    return { superseded: true, reason: 'newer-matching-setup' };
}

function normalizePath(value: string): string {
    return path.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
}
