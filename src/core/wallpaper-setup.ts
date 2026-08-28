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

export async function runWallpaperSetup(
    input: WallpaperSetupInput,
    dependencies: WallpaperSetupDependencies
): Promise<WallpaperSetupResult> {
    let stage = WallpaperSetupStage.ValidateMedia;
    const operationId = dependencies.createOperationId();
    const runStage = async (nextStage: WallpaperSetupStage, action: () => PromiseLike<void>) => {
        stage = nextStage;
        dependencies.report(stage, input);
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

        const confirmation: PendingSetupConfirmation = {
            operationId,
            wallpaperId: input.wallpaperId,
            wallpaperTitle: input.wallpaperTitle,
            dirPath: input.dirPath,
            fileName: input.fileName,
            createdAt: dependencies.now()
        };
        await dependencies.savePendingConfirmation(confirmation);
        await runStage(WallpaperSetupStage.ReloadWorkbench, () => dependencies.reloadWorkbench());
        return { operationId, confirmation };
    } catch (error) {
        const setupError = asSetupError(stage, error);
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
    confirmation: PendingSetupConfirmation,
    currentWallpaperId: string,
    now: number,
    maxAgeMs = 5 * 60 * 1000
): boolean {
    return typeof confirmation === 'object'
        && confirmation !== null
        && typeof confirmation.dirPath === 'string'
        && confirmation.dirPath.length > 0
        && typeof confirmation.fileName === 'string'
        && confirmation.fileName.length > 0
        && confirmation.wallpaperId === currentWallpaperId
        && isPendingConfirmationFresh(confirmation, now, maxAgeMs);
}
