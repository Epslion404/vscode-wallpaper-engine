import * as vscode from 'vscode';
import * as fs from 'fs';
import { ThemeCompatibilityMode, isThemeCompatibilityMode } from '../core/theme-compatibility';
import { UiLanguage, isUiLanguage } from '../panels/localization';

export interface AppConfig {
    workshopPath: string;
    opacity: number;
    serverPort: number;
    wallpaperId: string;
    resizeDelay: number;
    startupCheckInterval: number;
    customCss: string;
    themeCompatibility: ThemeCompatibilityMode;
    uiLanguage: UiLanguage;
}

export function getConfiguration(): AppConfig {
    const config = vscode.workspace.getConfiguration('vscode-wallpaper-engine');
    const workshopPath = config.get<string>('workshopPath') || '';
    const opacity = config.get<number>('backgroundOpacity') || 0.3;
    const serverPort = config.get<number>('serverPort') || 23333;
    const wallpaperId = config.get<string>('wallpaperId') || '';
    const resizeDelay = config.get<number>('resizeDelay') || 500;
    const startupCheckInterval = config.get<number>('startupCheckInterval') || 300;
    const customCss = config.get<string>('customCss') || '';
    const configuredThemeCompatibility = config.get<unknown>('themeCompatibility');
    const themeCompatibility = isThemeCompatibilityMode(configuredThemeCompatibility)
        ? configuredThemeCompatibility
        : 'auto';
    const configuredUiLanguage = config.get<unknown>('uiLanguage');
    const uiLanguage = isUiLanguage(configuredUiLanguage) ? configuredUiLanguage : 'auto';

    return { workshopPath, opacity, serverPort, wallpaperId, resizeDelay, startupCheckInterval, customCss, themeCompatibility, uiLanguage };
}

export function getConfigValidationError(config: AppConfig): string | undefined {
    let isDirectory = false;
    if (config.workshopPath) {
        try {
            isDirectory = fs.statSync(config.workshopPath).isDirectory();
        } catch (error) {
            console.warn(`[Config] Invalid workshop path: ${config.workshopPath}`, error);
        }
    }

    if (!config.workshopPath || !isDirectory) {
        return '请先配置正确的 Wallpaper Engine 创意工坊目录。';
    }
    return undefined;
}

export function validateConfig(config: AppConfig): boolean {
    return getConfigValidationError(config) === undefined;
}
