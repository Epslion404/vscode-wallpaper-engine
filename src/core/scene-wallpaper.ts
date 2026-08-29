import * as path from 'path';
import * as vscode from 'vscode';
import { AppConfig } from '../config';
import { resolveUiLanguage } from '../panels/localization';
import { SettingsPanel } from '../panels/setting-panel';
import { WallpaperOutput } from './output';
import {
    CURRENT_PLAYBACK_STATE_KEY,
    validatePlaybackDescriptor,
    WallpaperPlaybackDescriptor
} from './playback-state';
import {
    DEFAULT_SCENE_RECORDING_SECONDS,
    findLatestValidSceneCache,
    MAX_SCENE_RECORDING_SECONDS,
    MIN_SCENE_RECORDING_SECONDS,
    parseSceneRecordingDuration,
    SCENE_VIDEO_CODEC,
    SceneRecordingProfile
} from './scene-cache';
import { createDirectPlaybackDescriptor, createScenePlaybackDescriptor } from './scene-preparation';
import {
    detectSceneExecutables,
    SceneExecutables,
    validateFfmpegExecutable,
    validateWallpaperEngineExecutable
} from './scene-dependencies';
import {
    recordSceneToCache,
    SceneRecordingProgress
} from './scene-recorder';
import { getWallpaperById, WallpaperItem } from './scanner';
import { WallpaperType } from './types';
import { WallpaperSetupStage } from './wallpaper-setup';

function sceneProgressMessage(state: SceneRecordingProgress, english: boolean): string {
    if (!english) {
        return state.message;
    }
    switch (state.stage) {
        case 'launch':
            return 'Starting the Wallpaper Engine Scene window…';
        case 'waitWindow':
            return 'Waiting for the Scene window to render…';
        case 'record':
            return `Recording ${state.elapsedSeconds ?? 0}/${state.totalSeconds ?? 0} seconds…`;
        case 'validate':
            return state.message.includes('H.264')
                ? 'Converting the Scene recording to H.264/MP4…'
                : 'Validating the Scene video cache…';
        case 'cleanup':
            return 'Cleaning up the Scene recording window and temporary files…';
    }
}

export class SceneWallpaperService {
    private readonly cacheRoot: string;

    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: WallpaperOutput
    ) {
        this.cacheRoot = path.join(context.globalStorageUri.fsPath, 'scene-cache');
    }

    public isEnglishUi(config: AppConfig): boolean {
        return resolveUiLanguage(config.uiLanguage, vscode.env.language) === 'en-US';
    }

    public async prepareSelected(
        item: WallpaperItem,
        config: AppConfig,
        operationId: string
    ): Promise<WallpaperPlaybackDescriptor | undefined> {
        if (item.type !== WallpaperType.Scene) {
            return createDirectPlaybackDescriptor(item);
        }

        const source = item.getSceneSource();
        const existingCache = await findLatestValidSceneCache(this.cacheRoot, source);
        if (existingCache) {
            const english = this.isEnglishUi(config);
            const action = await vscode.window.showQuickPick([
                { label: english ? 'Use existing cache' : '使用已有缓存', value: 'use' as const },
                { label: english ? 'Record again' : '重新录制', value: 'record' as const }
            ], {
                title: english ? 'Scene cache found' : '已找到 Scene 视频缓存',
                placeHolder: english ? 'Choose how to continue' : '请选择如何继续'
            });
            if (!action) {
                return undefined;
            }
            if (action.value === 'use') {
                this.output.info(operationId, `复用 Scene 缓存，时长 ${existingCache.manifest.durationSeconds} 秒`);
                return createScenePlaybackDescriptor(item, existingCache);
            }
        }

        const durationSeconds = await this.promptDuration(config);
        if (durationSeconds === undefined) {
            return undefined;
        }
        const executables = await this.resolveExecutables(config);
        if (!executables) {
            return undefined;
        }
        const profile: SceneRecordingProfile = {
            durationSeconds,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: SCENE_VIDEO_CODEC
        };
        const cache = await this.record(item, source, profile, executables, config, operationId);
        return createScenePlaybackDescriptor(item, cache);
    }

    public async resolveConfigured(config: AppConfig): Promise<WallpaperPlaybackDescriptor | undefined> {
        const persistedPlayback = this.context.globalState.get(CURRENT_PLAYBACK_STATE_KEY);
        if (!config.wallpaperId || !config.workshopPath) {
            if (persistedPlayback !== undefined) {
                await this.context.globalState.update(CURRENT_PLAYBACK_STATE_KEY, undefined);
                this.output.info('activation', '壁纸配置为空，已清理旧播放状态');
            }
            return undefined;
        }
        const stored = await validatePlaybackDescriptor(
            persistedPlayback,
            config.wallpaperId
        );
        if (persistedPlayback !== undefined && !stored) {
            await this.context.globalState.update(CURRENT_PLAYBACK_STATE_KEY, undefined);
            this.output.info('activation', '持久化播放状态与当前壁纸不匹配，已清理');
        }
        if (stored?.sourceType === WallpaperType.Scene) {
            const item = getWallpaperById(config.workshopPath, config.wallpaperId);
            if (!item || item.type !== WallpaperType.Scene) {
                return undefined;
            }
            const cache = await findLatestValidSceneCache(this.cacheRoot, item.getSceneSource());
            const playback = cache ? createScenePlaybackDescriptor(item, cache) : undefined;
            if (playback && playback.mediaPath !== stored.mediaPath) {
                await this.context.globalState.update(CURRENT_PLAYBACK_STATE_KEY, playback);
            }
            return playback;
        }
        if (stored) {
            return stored;
        }

        const item = getWallpaperById(config.workshopPath, config.wallpaperId);
        if (!item) {
            return undefined;
        }
        const playback = item.type === WallpaperType.Scene
            ? await findLatestValidSceneCache(this.cacheRoot, item.getSceneSource())
                .then(cache => cache ? createScenePlaybackDescriptor(item, cache) : undefined)
            : createDirectPlaybackDescriptor(item);
        if (playback) {
            await this.context.globalState.update(CURRENT_PLAYBACK_STATE_KEY, playback);
            this.output.info('activation', '已恢复或迁移壁纸播放状态');
        }
        return playback;
    }

    private async chooseExecutable(
        configKey: 'wallpaperEnginePath' | 'ffmpegPath',
        title: string,
        validator: (candidate: string) => Promise<boolean>
    ): Promise<string | undefined> {
        const selected = await vscode.window.showOpenDialog({
            title,
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { Executable: ['exe'] }
        });
        const selectedPath = selected?.[0]?.fsPath;
        if (!selectedPath) {
            return undefined;
        }
        if (!await validator(selectedPath)) {
            await vscode.window.showErrorMessage(`${title}：所选程序不可用或缺少所需能力。`);
            return undefined;
        }
        await vscode.workspace.getConfiguration('vscode-wallpaper-engine')
            .update(configKey, selectedPath, vscode.ConfigurationTarget.Global);
        return selectedPath;
    }

    private async resolveExecutables(config: AppConfig): Promise<SceneExecutables | undefined> {
        const detected = await detectSceneExecutables({
            configuredWallpaperEnginePath: config.wallpaperEnginePath,
            configuredFfmpegPath: config.ffmpegPath,
            workshopPath: config.workshopPath
        });
        let wallpaperEnginePath = detected.wallpaperEnginePath;
        let ffmpegPath = detected.ffmpegPath;
        if (!wallpaperEnginePath) {
            const action = await vscode.window.showErrorMessage(
                this.isEnglishUi(config)
                    ? 'Wallpaper Engine was not detected. Select wallpaper64.exe or wallpaper32.exe.'
                    : '未检测到 Wallpaper Engine，请选择 wallpaper64.exe 或 wallpaper32.exe。',
                this.isEnglishUi(config) ? 'Select File' : '选择程序'
            );
            if (action) {
                wallpaperEnginePath = await this.chooseExecutable(
                    'wallpaperEnginePath',
                    '选择 Wallpaper Engine / Select Wallpaper Engine',
                    validateWallpaperEngineExecutable
                );
            }
        }
        if (!ffmpegPath) {
            const action = await vscode.window.showErrorMessage(
                this.isEnglishUi(config)
                    ? 'A compatible FFmpeg with gdigrab and libx264 was not detected.'
                    : '未检测到同时支持 gdigrab 和 libx264 的 FFmpeg。',
                this.isEnglishUi(config) ? 'Select File' : '选择程序'
            );
            if (action) {
                ffmpegPath = await this.chooseExecutable(
                    'ffmpegPath',
                    '选择 FFmpeg / Select FFmpeg',
                    validateFfmpegExecutable
                );
            }
        }
        return wallpaperEnginePath && ffmpegPath ? { wallpaperEnginePath, ffmpegPath } : undefined;
    }

    private async promptDuration(config: AppConfig): Promise<number | undefined> {
        const english = this.isEnglishUi(config);
        const value = await vscode.window.showInputBox({
            title: english ? 'Record Scene wallpaper' : '录制 Scene 壁纸',
            prompt: english
                ? `Recording duration in seconds (${MIN_SCENE_RECORDING_SECONDS}-${MAX_SCENE_RECORDING_SECONDS}); leave empty for ${DEFAULT_SCENE_RECORDING_SECONDS} seconds.`
                : `录制秒数（${MIN_SCENE_RECORDING_SECONDS}-${MAX_SCENE_RECORDING_SECONDS}），留空默认 ${DEFAULT_SCENE_RECORDING_SECONDS} 秒。`,
            placeHolder: String(DEFAULT_SCENE_RECORDING_SECONDS),
            validateInput: input => parseSceneRecordingDuration(input) === undefined
                ? english
                    ? `Enter an integer from ${MIN_SCENE_RECORDING_SECONDS} to ${MAX_SCENE_RECORDING_SECONDS}.`
                    : `请输入 ${MIN_SCENE_RECORDING_SECONDS}-${MAX_SCENE_RECORDING_SECONDS} 的整数。`
                : undefined
        });
        return value === undefined ? undefined : parseSceneRecordingDuration(value);
    }

    private record(
        item: WallpaperItem,
        source: ReturnType<WallpaperItem['getSceneSource']>,
        profile: SceneRecordingProfile,
        executables: SceneExecutables,
        config: AppConfig,
        operationId: string
    ) {
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: this.isEnglishUi(config)
                ? `Recording Scene “${item.label.replace(/^\$\([^)]*\)\s*/, '')}”`
                : `正在录制 Scene「${item.label.replace(/^\$\([^)]*\)\s*/, '')}」`,
            cancellable: true
        }, async (progress, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());
            return recordSceneToCache({
                source,
                profile,
                executables,
                cacheRoot: this.cacheRoot,
                captureHelperPath: this.context.asAbsolutePath(path.join('bin', 'vwe-scene-capture-helper.exe')),
                operationId,
                signal: controller.signal,
                report: state => {
                    const message = sceneProgressMessage(state, this.isEnglishUi(config));
                    progress.report({ message });
                    const stage = state.stage === 'launch' || state.stage === 'waitWindow'
                        ? WallpaperSetupStage.LaunchSceneRenderer
                        : state.stage === 'record'
                            ? WallpaperSetupStage.RecordScene
                            : WallpaperSetupStage.ValidateSceneCache;
                    SettingsPanel.publishSetupState({ status: 'running', stage, message });
                },
                logger: {
                    info: message => this.output.info(operationId, message),
                    error: (message, error) => this.output.error(operationId, message, error)
                }
            });
        });
    }
}
