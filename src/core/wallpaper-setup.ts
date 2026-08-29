import { PlayableWallpaperType } from './types';

export enum WallpaperSetupStage {
    ValidateConfiguration = 'validateConfiguration',
    ScanLibrary = 'scanLibrary',
    SelectWallpaper = 'selectWallpaper',
    PrepareScene = 'prepareScene',
    LaunchSceneRenderer = 'launchSceneRenderer',
    RecordScene = 'recordScene',
    ValidateSceneCache = 'validateSceneCache',
    ValidateMedia = 'validateMedia',
    StartServer = 'startServer',
    VerifyHealth = 'verifyHealth',
    VerifyEntry = 'verifyEntry',
    VerifyPlayback = 'verifyPlayback',
    FinalizePlayback = 'finalizePlayback',
    ApplyTransparency = 'applyTransparency',
    InjectWorkbench = 'injectWorkbench',
    SaveConfiguration = 'saveConfiguration',
    ReloadWorkbench = 'reloadWorkbench'
}

export const PENDING_SETUP_CONFIRMATION_KEY = 'pendingSetupConfirmation';

export interface WallpaperSetupInput {
    wallpaperId: string;
    wallpaperTitle: string;
    dirPath: string;
    filePath: string;
    fileName: string;
    type: PlayableWallpaperType;
    port: number;
    opacity: number;
    resizeDelay: number;
    startupCheckInterval: number;
    location?: string;
}

export interface PendingSetupConfirmation {
    operationId: string;
    wallpaperId: string;
    wallpaperTitle: string;
    dirPath: string;
    fileName: string;
    playbackType: PlayableWallpaperType;
    createdAt: number;
}

export interface WallpaperSetupResult {
    operationId: string;
    confirmation: PendingSetupConfirmation;
}

export type WallpaperSetupViewState =
    | { status: 'idle'; message: string }
    | { status: 'running'; stage: WallpaperSetupStage; message: string }
    | { status: 'success'; message: string }
    | { status: 'error'; stage: WallpaperSetupStage; message: string };

export interface WallpaperSetupDependencies {
    validateMedia(input: WallpaperSetupInput): PromiseLike<void>;
    startServer(input: WallpaperSetupInput): PromiseLike<void>;
    verifyHealth(input: WallpaperSetupInput): PromiseLike<void>;
    verifyEntry(input: WallpaperSetupInput): PromiseLike<void>;
    applyTransparency(): PromiseLike<void>;
    inject(input: WallpaperSetupInput): PromiseLike<void>;
    updateWallpaperId(wallpaperId: string): PromiseLike<void>;
    savePendingConfirmation(confirmation: PendingSetupConfirmation): PromiseLike<void>;
    reloadWorkbench(): PromiseLike<void>;
    rollback(): PromiseLike<void>;
    report(stage: WallpaperSetupStage, input: WallpaperSetupInput): void;
    createOperationId(): string;
    now(): number;
}

export interface PendingSetupVerificationDependencies {
    verifyHealth(confirmation: PendingSetupConfirmation): PromiseLike<void>;
    verifyEntry(): PromiseLike<void>;
    verifyPlaybackReady(playbackType: PlayableWallpaperType): PromiseLike<void>;
    clearPendingConfirmation(): PromiseLike<void>;
    report(stage: WallpaperSetupStage): void;
}

export class WallpaperSetupError extends Error {
    public rollbackMessage?: string;

    public constructor(
        public readonly stage: WallpaperSetupStage,
        message: string,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'WallpaperSetupError';
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function asSetupError(stage: WallpaperSetupStage, error: unknown): WallpaperSetupError {
    if (error instanceof WallpaperSetupError) {
        return error;
    }
    return new WallpaperSetupError(stage, errorMessage(error), { cause: error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlayableWallpaperType(value: unknown): value is PlayableWallpaperType {
    return value === 'video' || value === 'image' || value === 'web';
}

/**
 * VS Code 在执行 Reload Window 时会主动终止旧 Extension Host，并可能以取消错误结束命令 Promise。
 * 这里只接受 VS Code 已知的精确取消标记，避免把真实的重载失败误判为成功。
 */
export function isExpectedReloadCancellation(error: unknown): boolean {
    if (!isRecord(error) && !(error instanceof Error)) {
        return false;
    }
    const candidate = error as { name?: unknown; message?: unknown; code?: unknown };
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    return name === 'CancellationError'
        || name === 'Canceled'
        || message === 'Canceled'
        || code === 'Canceled';
}

/** 持久化状态属于外部输入，旧结构或未知播放类型必须拒绝。 */
export function isPendingSetupConfirmation(value: unknown): value is PendingSetupConfirmation {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.operationId === 'string'
        && value.operationId.length > 0
        && typeof value.wallpaperId === 'string'
        && value.wallpaperId.length > 0
        && typeof value.wallpaperTitle === 'string'
        && value.wallpaperTitle.length > 0
        && typeof value.dirPath === 'string'
        && value.dirPath.length > 0
        && typeof value.fileName === 'string'
        && value.fileName.length > 0
        && isPlayableWallpaperType(value.playbackType)
        && typeof value.createdAt === 'number'
        && Number.isFinite(value.createdAt);
}

/** 新窗口按服务、入口、实际播放顺序确认，错误保留准确阶段。 */
export async function confirmPendingSetupPlayback(
    confirmation: PendingSetupConfirmation,
    dependencies: PendingSetupVerificationDependencies
): Promise<void> {
    let stage = WallpaperSetupStage.VerifyHealth;
    const runStage = async (nextStage: WallpaperSetupStage, action: () => PromiseLike<void>) => {
        stage = nextStage;
        dependencies.report(stage);
        await action();
    };
    try {
        await runStage(WallpaperSetupStage.VerifyHealth, () => dependencies.verifyHealth(confirmation));
        await runStage(WallpaperSetupStage.VerifyEntry, () => dependencies.verifyEntry());
        await runStage(
            WallpaperSetupStage.VerifyPlayback,
            () => dependencies.verifyPlaybackReady(confirmation.playbackType)
        );
        // pending 是跨 Extension Host 的事务凭据，只能在真实播放确认成功后清除。
        await runStage(
            WallpaperSetupStage.FinalizePlayback,
            () => dependencies.clearPendingConfirmation()
        );
    } catch (error) {
        throw asSetupError(stage, error);
    }
}

export async function runWallpaperSetup(
    input: WallpaperSetupInput,
    dependencies: WallpaperSetupDependencies
): Promise<WallpaperSetupResult> {
    const state: { stage: WallpaperSetupStage } = { stage: WallpaperSetupStage.ValidateMedia };
    const operationId = dependencies.createOperationId();
    let confirmation: PendingSetupConfirmation | undefined;
    const runStage = async (nextStage: WallpaperSetupStage, action: () => PromiseLike<void>) => {
        state.stage = nextStage;
        dependencies.report(state.stage, input);
        await action();
    };

    try {
        await runStage(WallpaperSetupStage.ValidateMedia, () => dependencies.validateMedia(input));
        await runStage(WallpaperSetupStage.StartServer, () => dependencies.startServer(input));
        await runStage(WallpaperSetupStage.VerifyHealth, () => dependencies.verifyHealth(input));
        await runStage(WallpaperSetupStage.VerifyEntry, () => dependencies.verifyEntry(input));
        await runStage(WallpaperSetupStage.ApplyTransparency, () => dependencies.applyTransparency());
        await runStage(WallpaperSetupStage.InjectWorkbench, () => dependencies.inject(input));
        await runStage(WallpaperSetupStage.SaveConfiguration, () => dependencies.updateWallpaperId(input.wallpaperId));

        confirmation = {
            operationId,
            wallpaperId: input.wallpaperId,
            wallpaperTitle: input.wallpaperTitle,
            dirPath: input.dirPath,
            fileName: input.fileName,
            playbackType: input.type,
            createdAt: dependencies.now()
        };
        await dependencies.savePendingConfirmation(confirmation);
        await runStage(WallpaperSetupStage.ReloadWorkbench, () => dependencies.reloadWorkbench());
        return { operationId, confirmation };
    } catch (error) {
        if (state.stage === WallpaperSetupStage.ReloadWorkbench
            && confirmation
            && isExpectedReloadCancellation(error)) {
            return { operationId, confirmation };
        }
        const setupError = asSetupError(state.stage, error);
        try {
            await dependencies.rollback();
        } catch (rollbackError) {
            setupError.rollbackMessage = errorMessage(rollbackError);
        }
        throw setupError;
    }
}

export function isPendingConfirmationFresh(
    confirmation: PendingSetupConfirmation,
    now: number,
    maxAgeMs = 5 * 60 * 1000
): boolean {
    return confirmation.createdAt <= now && now - confirmation.createdAt <= maxAgeMs;
}

export function shouldConfirmPendingSetup(
    confirmation: unknown,
    currentWallpaperId: string,
    now: number,
    maxAgeMs = 5 * 60 * 1000
): boolean {
    return isPendingSetupConfirmation(confirmation)
        && confirmation.wallpaperId === currentWallpaperId
        && isPendingConfirmationFresh(confirmation, now, maxAgeMs);
}
