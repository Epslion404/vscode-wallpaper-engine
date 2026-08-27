import * as vscode from 'vscode';
import * as fs from 'fs';

export interface AppConfig {
    workshopPath: string;
    opacity: number;
    serverPort: number;
    wallpaperId: string;
    resizeDelay: number;
    startupCheckInterval: number;
    customCss: string;
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

    return { workshopPath, opacity, serverPort, wallpaperId, resizeDelay, startupCheckInterval, customCss };
}

export function validateConfig(config: AppConfig): boolean {
    let isDirectory = false;
    if (config.workshopPath) {
        try {
            isDirectory = fs.statSync(config.workshopPath).isDirectory();
        } catch (error) {
            console.warn(`[Config] Invalid workshop path: ${config.workshopPath}`, error);
        }
    }

    if (!config.workshopPath || !isDirectory) {
        vscode.window.showErrorMessage('请先在设置中配置正确的 Wallpaper Engine 创意工坊目录！');
        return false;
    }
    return true;
}
