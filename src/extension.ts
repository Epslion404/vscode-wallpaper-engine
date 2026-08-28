// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfiguration, getConfigValidationError } from './config';
import { scanWallpapersWithDiagnostics, getWallpaperById, WallpaperScanStatistics } from './core/scanner';
import { performInjection, restoreWorkbench } from './core/injector';
import { validateWallpaperMedia, WallpaperServer } from './core/server';
import { applyTransparencyPatch, initializeTransparencyState, removeTransparencyPatch } from './core/config-patcher';
import { SettingsPanel } from './panels/setting-panel';
import { classifyConfigurationChange } from './configuration-change';
import { WallpaperOutput } from './core/output';
import { toUserErrorReason } from './core/user-message';
import {
    PENDING_SETUP_CONFIRMATION_KEY,
    PendingSetupConfirmation,
    runWallpaperSetup,
    shouldConfirmPendingSetup,
    WallpaperSetupError,
    WallpaperSetupInput,
    WallpaperSetupStage
} from './core/wallpaper-setup';

// test
import { openTestPage } from './playground/page';

const SHOW_DEBUG_SIDEBAR = false; // [Dev] Toggle Debug Sidebar

let server: WallpaperServer | undefined;
let isSettingWallpaper = false;

const STAGE_MESSAGES: Record<WallpaperSetupStage, string> = {
    [WallpaperSetupStage.ValidateConfiguration]: '正在检查扩展配置…',
    [WallpaperSetupStage.ScanLibrary]: '正在扫描壁纸库…',
    [WallpaperSetupStage.SelectWallpaper]: '正在等待选择壁纸…',
    [WallpaperSetupStage.ValidateMedia]: '正在校验壁纸媒体…',
    [WallpaperSetupStage.StartServer]: '正在启动本地服务…',
    [WallpaperSetupStage.VerifyHealth]: '正在检查服务状态…',
    [WallpaperSetupStage.VerifyEntry]: '正在验证壁纸入口…',
    [WallpaperSetupStage.ApplyTransparency]: '正在应用界面透明化…',
    [WallpaperSetupStage.InjectWorkbench]: '正在写入 Workbench…',
    [WallpaperSetupStage.SaveConfiguration]: '正在保存壁纸配置…',
    [WallpaperSetupStage.ReloadWorkbench]: '正在重新加载窗口…'
};

function createOperationId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function setupErrorMessage(error: WallpaperSetupError): string {
    return `设置壁纸失败（${STAGE_MESSAGES[error.stage].replace(/^正在|…$/g, '')}）：${toUserErrorReason(error)}`;
}

function scanFailureMessage(statistics: WallpaperScanStatistics): string {
    if (statistics.permissionDenied > 0) {
        return `未找到可用壁纸，其中 ${statistics.permissionDenied} 个目录无权访问。`;
    }
    if (statistics.corrupted > 0 || statistics.unsupported > 0) {
        return `未找到可用壁纸：损坏 ${statistics.corrupted} 个，不支持 ${statistics.unsupported} 个。`;
    }
    return '未找到任何壁纸，请检查创意工坊目录。';
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "vscode-wallpaper-engine" is now active!');
    
    const output = new WallpaperOutput();
    context.subscriptions.push(output);
    server = new WallpaperServer(context);
    initializeTransparencyState(context);
    const initialConfig = getConfiguration();
    const savedPath = context.globalState.get<string>('currentWallpaperPath');
    const savedEntry = context.globalState.get<string>('currentWallpaperEntry');
    const savedLocation = context.globalState.get<string>('currentWallpaperLocation');
    let restoredServer = false;
    if (savedPath) {
        try {
            await server.start(savedPath, initialConfig.serverPort, savedEntry, savedLocation, true);
            restoredServer = true;
        } catch (error) {
            output.error('activation', '恢复壁纸服务失败', error);
        }
    }

    const pendingConfirmation = context.globalState.get<PendingSetupConfirmation>(PENDING_SETUP_CONFIRMATION_KEY);
    if (pendingConfirmation) {
        await context.globalState.update(PENDING_SETUP_CONFIRMATION_KEY, undefined);
        const shouldConfirm = shouldConfirmPendingSetup(pendingConfirmation, initialConfig.wallpaperId, Date.now());
        if (restoredServer && shouldConfirm) {
            try {
                await server.verifyHealth(undefined, {
                    rootPath: pendingConfirmation.dirPath,
                    entryFile: pendingConfirmation.fileName
                });
                await server.verifyEntry();
                vscode.window.setStatusBarMessage('$(check) 壁纸已生效', 5000);
                SettingsPanel.publishSetupState({ status: 'success', message: `壁纸「${pendingConfirmation.wallpaperTitle}」已生效` });
                await vscode.window.showInformationMessage(`壁纸「${pendingConfirmation.wallpaperTitle}」已设置并生效。`);
                output.info(pendingConfirmation.operationId, '窗口重载后确认壁纸已生效');
            } catch (error) {
                output.error(pendingConfirmation.operationId, '窗口重载后验证失败', error);
                SettingsPanel.publishSetupState({
                    status: 'error',
                    stage: WallpaperSetupStage.VerifyEntry,
                    message: '窗口重载后的生效验证失败'
                });
                const action = await vscode.window.showErrorMessage('壁纸设置已完成，但重载后的生效验证失败。', '查看日志');
                if (action === '查看日志') { output.show(); }
            }
        } else if (shouldConfirm) {
            output.error(pendingConfirmation.operationId, '窗口重载后无法恢复壁纸服务', new Error('服务恢复失败'));
            SettingsPanel.publishSetupState({
                status: 'error',
                stage: WallpaperSetupStage.ReloadWorkbench,
                message: '窗口重载后无法恢复壁纸服务，请查看日志并重试'
            });
            const action = await vscode.window.showErrorMessage('窗口重载后无法确认壁纸是否生效。', '重试', '查看日志');
            if (action === '重试') {
                await vscode.commands.executeCommand('vscode-wallpaper-engine.setWallpaper');
            } else if (action === '查看日志') {
                output.show();
            }
        } else {
            output.info('activation', '丢弃过期、格式无效或已变化的壁纸待确认记录');
        }
    }

    const applyWallpaper = async (forceReload = false, silent = false) => {
        const config = getConfiguration();
        if (!config.wallpaperId || !config.workshopPath) {
            if (!silent) {
                await vscode.window.showWarningMessage('请先配置创意工坊目录并选择壁纸。');
            }
            return; 
        }

        const item = getWallpaperById(config.workshopPath, config.wallpaperId);
        if (item) {
            const { path: filePath, type } = item.getMediaPath();
            const fileName = path.basename(filePath);
            
            if (server) {
                await server.start(item.dirPath, config.serverPort, fileName, item.location);
                server.updateCssConfig({
                    customCss: config.customCss
                });
            }

            await performInjection(filePath, type, config.opacity, config.serverPort, config.resizeDelay, config.startupCheckInterval, false, SHOW_DEBUG_SIDEBAR);
            
            // Apply transparency patch
            await applyTransparencyPatch();
            
            if (silent) { return; }

            if (forceReload) {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            } else {
                const action = await vscode.window.showInformationMessage('Wallpaper Engine 设置已更改，需要重新加载窗口后生效。', '立即重新加载');
                if (action === '立即重新加载') {
                    await vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            }
        }
    };

    // Watch for config changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
        if (isSettingWallpaper) { return; }
        
        const changedKeys = [
            'wallpaperId', 'workshopPath', 'backgroundOpacity', 'serverPort',
            'resizeDelay', 'startupCheckInterval', 'customCss',
            'transparencyEnabled', 'transparencyRules', 'transparencyBaseColor'
        ].filter(key => e.affectsConfiguration(`vscode-wallpaper-engine.${key}`));
        const { wallpaper, transparency } = classifyConfigurationChange(changedKeys);

        if (wallpaper && changedKeys.length === 1 && changedKeys[0] === 'wallpaperId') {
             const config = getConfiguration();
             if (config.wallpaperId && config.workshopPath) {
                const item = getWallpaperById(config.workshopPath, config.wallpaperId);
                if (item && server) {
                    await applyWallpaper(false, true);
                    return;
                }
             }
        }

        if (wallpaper) {
            await applyWallpaper(changedKeys.includes('serverPort'));
        } else if (transparency) {
            await applyTransparencyPatch();
        }
    }));

    // Watch for theme changes to re-apply transparency patch with correct base color
    context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(async () => {
        // Wait a bit for the theme to fully apply
        setTimeout(async () => {
            await applyTransparencyPatch();
        }, 1000);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('vscode-wallpaper-engine.refreshWallpaper', async () => {
        if (!server || !server.getCurrentRoot()) {
            const action = await vscode.window.showWarningMessage('壁纸服务未运行，请先设置壁纸。', '设置壁纸');
            if (action === '设置壁纸') {
                await vscode.commands.executeCommand('vscode-wallpaper-engine.setWallpaper');
            }
            return;
        }
        const operationId = createOperationId();
        try {
            await server.verifyHealth();
            await server.triggerReloadAndWait();
            output.info(operationId, '壁纸客户端已确认刷新信号');
            await vscode.window.showInformationMessage('壁纸已刷新。');
        } catch (error) {
            output.error(operationId, '刷新壁纸失败', error);
            const action = await vscode.window.showErrorMessage('刷新壁纸失败：壁纸客户端未确认刷新信号。', '查看日志', '重新设置壁纸');
            if (action === '查看日志') { output.show(); }
            if (action === '重新设置壁纸') {
                await vscode.commands.executeCommand('vscode-wallpaper-engine.setWallpaper');
            }
        }
    }));

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('vscode-wallpaper-engine.helloWorld', () => {
		openTestPage();    
	});
	context.subscriptions.push(disposable);

	// command to set wallpaper
	const setWallPaperCmd = vscode.commands.registerCommand('vscode-wallpaper-engine.setWallpaper', async () => {
        if (isSettingWallpaper) {
            vscode.window.setStatusBarMessage('$(sync~spin) 已有壁纸设置任务正在进行', 3000);
            return;
        }
        isSettingWallpaper = true;
        let retryRequested = false;
        try {
        SettingsPanel.publishSetupState({
            status: 'running',
            stage: WallpaperSetupStage.ValidateConfiguration,
            message: STAGE_MESSAGES[WallpaperSetupStage.ValidateConfiguration]
        });
        const config = getConfiguration();
        const validationError = getConfigValidationError(config);
        if (validationError) {
            SettingsPanel.publishSetupState({
                status: 'error',
                stage: WallpaperSetupStage.ValidateConfiguration,
                message: validationError
            });
            const action = await vscode.window.showErrorMessage(validationError, '打开设置');
            if (action === '打开设置') {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'vscode-wallpaper-engine.workshopPath');
            }
            return;
        }

        SettingsPanel.publishSetupState({
            status: 'running',
            stage: WallpaperSetupStage.ScanLibrary,
            message: STAGE_MESSAGES[WallpaperSetupStage.ScanLibrary]
        });
        const scanResult = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在扫描 Wallpaper Engine 壁纸库…',
            cancellable: false
        }, async () => scanWallpapersWithDiagnostics(config.workshopPath, diagnostic => {
            output.error('scan', `${diagnostic.wallpaperId || '工坊目录'}: ${diagnostic.message}`, diagnostic.cause);
        }));

        if (scanResult.items.length === 0) {
            SettingsPanel.publishSetupState({ status: 'idle', message: '未找到可用壁纸' });
            const action = await vscode.window.showWarningMessage(scanFailureMessage(scanResult.statistics), '打开目录', '打开设置', '查看日志');
            if (action === '打开目录') {
                await vscode.env.openExternal(vscode.Uri.file(config.workshopPath));
            }
            if (action === '打开设置') {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'vscode-wallpaper-engine.workshopPath');
            }
            if (action === '查看日志') { output.show(); }
            return;
        }

        SettingsPanel.publishSetupState({
            status: 'running',
            stage: WallpaperSetupStage.SelectWallpaper,
            message: STAGE_MESSAGES[WallpaperSetupStage.SelectWallpaper]
        });
        const selected = await vscode.window.showQuickPick(scanResult.items, {
            placeHolder: '选择一个壁纸（支持搜索）',
            matchOnDescription: true
        });
        if (!selected) {
            output.info('selection', '用户取消选择壁纸');
            SettingsPanel.publishSetupState({ status: 'idle', message: '已取消设置壁纸' });
            return;
        }

        const { path: filePath, type } = selected.getMediaPath();
        const setupInput: WallpaperSetupInput = {
            wallpaperId: selected.id,
            wallpaperTitle: selected.label.replace(/^\$\([^)]*\)\s*/, ''),
            dirPath: selected.dirPath,
            filePath,
            fileName: path.basename(filePath),
            type,
            port: config.serverPort,
            opacity: config.opacity,
            resizeDelay: config.resizeDelay,
            startupCheckInterval: config.startupCheckInterval,
            location: selected.location
        };
        const oldWallpaperId = config.wallpaperId;
        const oldWallpaper = oldWallpaperId ? getWallpaperById(config.workshopPath, oldWallpaperId) : null;
        const operationId = createOperationId();
        output.info(operationId, `开始设置壁纸「${setupInput.wallpaperTitle}」`);
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `正在设置「${setupInput.wallpaperTitle}」`,
                cancellable: false
            }, async progress => {
                await runWallpaperSetup(setupInput, {
                    validateMedia: input => validateWallpaperMedia(input.filePath),
                    startServer: async input => {
                        if (!server) { throw new Error('壁纸服务器未初始化'); }
                        await server.start(input.dirPath, input.port, input.fileName, input.location, true);
                        server.updateCssConfig({ customCss: config.customCss });
                    },
                    verifyHealth: async () => {
                        if (!server) { throw new Error('壁纸服务器未初始化'); }
                        await server.verifyHealth();
                    },
                    verifyEntry: async () => {
                        if (!server) { throw new Error('壁纸服务器未初始化'); }
                        await server.verifyEntry();
                    },
                    applyTransparency: () => applyTransparencyPatch(),
                    inject: input => performInjection(
                        input.filePath,
                        input.type,
                        input.opacity,
                        input.port,
                        input.resizeDelay,
                        input.startupCheckInterval,
                        false,
                        SHOW_DEBUG_SIDEBAR
                    ),
                    updateWallpaperId: wallpaperId => vscode.workspace
                        .getConfiguration('vscode-wallpaper-engine')
                        .update('wallpaperId', wallpaperId, vscode.ConfigurationTarget.Global),
                    savePendingConfirmation: confirmation => context.globalState.update(PENDING_SETUP_CONFIRMATION_KEY, confirmation),
                    reloadWorkbench: () => vscode.commands.executeCommand('workbench.action.reloadWindow').then(() => undefined),
                    rollback: async () => {
                        await context.globalState.update(PENDING_SETUP_CONFIRMATION_KEY, undefined);
                        await vscode.workspace.getConfiguration('vscode-wallpaper-engine')
                            .update('wallpaperId', oldWallpaperId, vscode.ConfigurationTarget.Global);
                        if (server && oldWallpaper) {
                            const previousMedia = oldWallpaper.getMediaPath();
                            await server.start(
                                oldWallpaper.dirPath,
                                config.serverPort,
                                path.basename(previousMedia.path),
                                oldWallpaper.location,
                                true
                            );
                            server.updateCssConfig({ customCss: config.customCss });
                            await server.verifyHealth();
                            await server.verifyEntry();
                            await performInjection(
                                previousMedia.path,
                                previousMedia.type,
                                config.opacity,
                                config.serverPort,
                                config.resizeDelay,
                                config.startupCheckInterval,
                                false,
                                SHOW_DEBUG_SIDEBAR
                            );
                            await applyTransparencyPatch();
                        } else if (server) {
                            await server.stop();
                            await restoreWorkbench();
                            await removeTransparencyPatch();
                        }
                    },
                    report: stage => {
                        const message = STAGE_MESSAGES[stage];
                        progress.report({ message });
                        output.stage(operationId, stage, message);
                        SettingsPanel.publishSetupState({ status: 'running', stage, message });
                    },
                    createOperationId: () => operationId,
                    now: () => Date.now()
                });
            });
        } catch (error) {
            const setupError = error instanceof WallpaperSetupError
                ? error
                : new WallpaperSetupError(WallpaperSetupStage.SaveConfiguration, String(error), { cause: error });
            output.error(operationId, '设置壁纸失败', setupError);
            if (setupError.rollbackMessage) {
                output.error(operationId, '恢复旧壁纸失败', new Error(setupError.rollbackMessage));
            }
            SettingsPanel.publishSetupState({ status: 'error', stage: setupError.stage, message: setupErrorMessage(setupError) });
            const action = await vscode.window.showErrorMessage(setupErrorMessage(setupError), '重试', '打开设置', '查看日志');
            if (action === '重试') {
                retryRequested = true;
            }
            if (action === '打开设置') {
                await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vakesamahere.vscode-wallpaper-engine');
            }
            if (action === '查看日志') { output.show(); }
        }
        } finally {
            isSettingWallpaper = false;
        }
        if (retryRequested) {
            await vscode.commands.executeCommand('vscode-wallpaper-engine.setWallpaper');
        }
    });
	context.subscriptions.push(setWallPaperCmd);

    const openInBrowserCmd = vscode.commands.registerCommand('vscode-wallpaper-engine.openInBrowser', async () => {
        const config = getConfiguration();
        const url = `http://127.0.0.1:${config.serverPort}/api/get-entry`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
    });
    context.subscriptions.push(openInBrowserCmd);

    const uninstallCmd = vscode.commands.registerCommand('vscode-wallpaper-engine.uninstallWallpaper', async () => {
        const confirm = await vscode.window.showWarningMessage(
            '确定要卸载 Wallpaper Engine 插件吗？这将移除所有注入的代码和修改。',
            { modal: true },
            '卸载'
        );
        if (confirm === '卸载') {
            const operationId = createOperationId();
            try {
                await restoreWorkbench();
                await removeTransparencyPatch();
                await server?.stop();
                output.info(operationId, 'Workbench、透明化配置和壁纸服务已还原');
                await vscode.window.showInformationMessage('Wallpaper Engine 已还原。');
            } catch (error: unknown) {
                output.error(operationId, '卸载还原失败', error);
                const action = await vscode.window.showErrorMessage(`卸载还原失败：${toUserErrorReason(error)}`, '查看日志');
                if (action === '查看日志') { output.show(); }
            }
        }
    });
    context.subscriptions.push(uninstallCmd);

    context.subscriptions.push(vscode.commands.registerCommand('vscode-wallpaper-engine.openSettings', () => {
        if (server) {
            SettingsPanel.createOrShow(context.extensionUri, server);
        } else {
            void vscode.window.showErrorMessage('壁纸服务尚未初始化。');
        }
    }));

    // Edit Custom CSS Command
    const cssStoragePath = path.join(context.globalStorageUri.fsPath, 'custom.css');
    const editCustomCssCmd = vscode.commands.registerCommand('vscode-wallpaper-engine.editCustomCss', async () => {
        const config = getConfiguration();
        const cssContent = config.customCss || '/* Enter your custom CSS here */';
        
        if (!fs.existsSync(context.globalStorageUri.fsPath)) {
            fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
        }
        
        fs.writeFileSync(cssStoragePath, cssContent, 'utf-8');
        
        const doc = await vscode.workspace.openTextDocument(cssStoragePath);
        await vscode.window.showTextDocument(doc);
    });
    context.subscriptions.push(editCustomCssCmd);

    // Listen for CSS file save
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (path.normalize(doc.fileName) === path.normalize(cssStoragePath)) {
            const content = doc.getText();
            const config = vscode.workspace.getConfiguration('vscode-wallpaper-engine');
            await config.update('customCss', content, vscode.ConfigurationTarget.Global);
            
            if (server) {
                const currentConfig = getConfiguration();
                server.updateCssConfig({
                    customCss: content
                });
                server.triggerReload();
                vscode.window.setStatusBarMessage('Wallpaper CSS Updated', 2000);
            }
        }
    }));
}

// This method is called when your extension is deactivated
export async function deactivate() {
    try {
        await restoreWorkbench();
        await removeTransparencyPatch();
        await server?.stop();
    } catch (error: unknown) {
        console.error('[Wallpaper] Deactivation cleanup failed:', error);
    }
}
