import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AppConfig } from '../config';
import { CURRENT_PLAYBACK_STATE_KEY, WallpaperPlaybackDescriptor } from '../core/playback-state';
import { WallpaperOutput } from '../core/output';
import { SceneWallpaperService } from '../core/scene-wallpaper';
import { WallpaperType } from '../core/types';

suite('Scene Wallpaper Service Test Suite', () => {
    let tempDir: string;
    let state: Map<string, unknown>;
    let service: SceneWallpaperService;

    const baseConfig: AppConfig = {
        workshopPath: '',
        opacity: 0.1,
        serverPort: 23333,
        wallpaperId: '',
        resizeDelay: 100,
        startupCheckInterval: 100,
        customCss: '',
        themeCompatibility: 'auto',
        uiLanguage: 'zh-CN',
        wallpaperEnginePath: '',
        ffmpegPath: ''
    };

    setup(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-wallpaper-scene-service-'));
        state = new Map<string, unknown>();
        const context = {
            globalStorageUri: vscode.Uri.file(path.join(tempDir, 'global-storage')),
            globalState: {
                get<T>(key: string): T | undefined {
                    return state.get(key) as T | undefined;
                },
                async update(key: string, value: unknown): Promise<void> {
                    if (value === undefined) {
                        state.delete(key);
                    } else {
                        state.set(key, value);
                    }
                }
            }
        } as unknown as vscode.ExtensionContext;
        const output = {
            info: () => undefined,
            error: () => undefined
        } as unknown as WallpaperOutput;
        service = new SceneWallpaperService(context, output);
    });

    teardown(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    async function createStoredPlayback(wallpaperId: string): Promise<WallpaperPlaybackDescriptor> {
        const rootPath = path.join(tempDir, 'old-cache');
        const mediaPath = path.join(rootPath, 'scene.webm');
        await fs.mkdir(rootPath, { recursive: true });
        await fs.writeFile(mediaPath, 'video');
        return {
            version: 1,
            wallpaperId,
            wallpaperTitle: 'old scene',
            sourceType: WallpaperType.Scene,
            rootPath,
            mediaPath,
            entryFile: path.basename(mediaPath),
            playbackType: WallpaperType.Video,
            location: rootPath
        };
    }

    test('clears persisted playback when wallpaper configuration is empty', async () => {
        state.set(CURRENT_PLAYBACK_STATE_KEY, await createStoredPlayback('old-id'));

        const resolved = await service.resolveConfigured(baseConfig);

        assert.strictEqual(resolved, undefined);
        assert.strictEqual(state.has(CURRENT_PLAYBACK_STATE_KEY), false);
    });

    test('clears a mismatched playback state when the configured Scene has no cache', async () => {
        state.set(CURRENT_PLAYBACK_STATE_KEY, await createStoredPlayback('old-id'));
        const workshopPath = path.join(tempDir, 'workshop');
        const sceneDir = path.join(workshopPath, 'new-id');
        await fs.mkdir(sceneDir, { recursive: true });
        await Promise.all([
            fs.writeFile(path.join(sceneDir, 'project.json'), JSON.stringify({
                title: 'new scene',
                type: 'scene',
                file: 'scene.pkg'
            })),
            fs.writeFile(path.join(sceneDir, 'scene.pkg'), 'scene package')
        ]);

        const resolved = await service.resolveConfigured({
            ...baseConfig,
            workshopPath,
            wallpaperId: 'new-id'
        });

        assert.strictEqual(resolved, undefined);
        assert.strictEqual(state.has(CURRENT_PLAYBACK_STATE_KEY), false);
    });
});
