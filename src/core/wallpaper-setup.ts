import { WallpaperType } from './types';

export enum WallpaperSetupStage {
    ValidateMedia = 'validateMedia',
    StartServer = 'startServer',
    VerifyEntry = 'verifyEntry',
    ApplyTransparency = 'applyTransparency',
    InjectWorkbench = 'injectWorkbench',
    SaveConfiguration = 'saveConfiguration'
}

export interface WallpaperSetupInput {
    wallpaperId: string;
    wallpaperTitle: string;
    dirPath: string;
    filePath: string;
    fileName: string;
    type: WallpaperType;
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
    createdAt: number;
}

export interface WallpaperSetupResult {
    operationId: string;
    confirmation: PendingSetupConfirmation;
}

export interface WallpaperSetupDependencies {
    validateMedia(input: WallpaperSetupInput): Promise<void>;
    startServer(input: WallpaperSetupInput): Promise<void>;
    verifyEntry(input: WallpaperSetupInput): Promise<void>;
    applyTransparency(): Promise<void>;
    inject(input: WallpaperSetupInput): Promise<void>;
    updateWallpaperId(wallpaperId: string): Promise<void>;
    savePendingConfirmation(confirmation: PendingSetupConfirmation): Promise<void>;
    rollback(): Promise<void>;
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
    const runStage = async (nextStage: WallpaperSetupStage, action: () => Promise<void>) => {
        stage = nextStage;
        dependencies.report(stage, input);
        await action();
    };

    try {
        await runStage(WallpaperSetupStage.ValidateMedia, () => dependencies.validateMedia(input));
        await runStage(WallpaperSetupStage.StartServer, () => dependencies.startServer(input));
        await runStage(WallpaperSetupStage.VerifyEntry, () => dependencies.verifyEntry(input));
        await runStage(WallpaperSetupStage.ApplyTransparency, () => dependencies.applyTransparency());
        await runStage(WallpaperSetupStage.InjectWorkbench, () => dependencies.inject(input));
        await runStage(WallpaperSetupStage.SaveConfiguration, () => dependencies.updateWallpaperId(input.wallpaperId));

        const confirmation: PendingSetupConfirmation = {
            operationId: dependencies.createOperationId(),
            wallpaperId: input.wallpaperId,
            wallpaperTitle: input.wallpaperTitle,
            createdAt: dependencies.now()
        };
        await dependencies.savePendingConfirmation(confirmation);
        return { operationId: confirmation.operationId, confirmation };
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
