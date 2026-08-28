// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getConfiguration, getConfigValidationError } from './config';
import { scanWallpapersWithDiagnostics, getWallpaperById, WallpaperScanStatistics } from './core/scanner';
import { isPatched, performInjection, restoreWorkbench } from './core/injector';
import { validateWallpaperMedia, WallpaperServer } from './core/server';
import { applyTransparencyPatch, hasTransparencyBackups, initializeTransparencyState, removeTransparencyPatch } from './core/config-patcher';
import { SettingsPanel } from './panels/setting-panel';
import { classifyConfigurationChange } from './configuration-change';
import { WallpaperOutput } from './core/output';
import { toUserErrorReason } from './core/user-message';
import {
    PENDING_SETUP_CONFIRMATION_KEY,
    runWallpaperSetup,
    shouldConfirmPendingSetup,
    WallpaperSetupError,
    WallpaperSetupInput,
    WallpaperSetupStage
} from './core/wallpaper-setup';
import { LifecycleState } from './core/lifecycle-state';
import { isPendingUninstall, PendingUninstall, runUninstall, UninstallStage, verifyUninstallState } from './core/uninstall';
import { evaluateUninstallSupersession, isPendingSetupState, needsWallpaperInjection } from './core/wallpaper-runtime';
import { extractThemeDescriptors, shouldApplyThemeCompatibility } from './core/theme-compatibility';

// test
import { openTestPage } from './playground/page';

const SHOW_DEBUG_SIDEBAR = false; // [Dev] Toggle Debug Sidebar

let server: WallpaperServer | undefined;
let lifecycle: LifecycleState | undefined;
const PENDING_UNINSTALL_KEY = 'pendingUninstall';
const DISABLED_KEY = 'wallpaperEngineDisabled';

const UNINSTALL_STAGE_MESSAGES: Record<UninstallStage, string> = {
    [UninstallStage.AcquireLock]: '正在锁定壁纸生命周期操作…',
    [UninstallStage.Disable]: '正在暂停自动注入…',
    [UninstallStage.ClearPendingSetup]: '正在清理待确认状态…',
    [UninstallStage.RestoreWorkbench]: '正在恢复 Workbench 文件…',
    [UninstallStage.RemoveTransparency]: '正在恢复透明化配置…',
    [UninstallStage.StopServer]: '正在停止本地壁纸服务…',
    [UninstallStage.ClearPersistedState]: '正在清理壁纸运行状态…',
    [UninstallStage.SavePending]: '正在保存重载后的验证任务…',
    [UninstallStage.ReloadWorkbench]: '正在重新加载窗口…',
    [UninstallStage.ReleaseLock]: '正在释放操作锁…'
};

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
    lifecycle = new LifecycleState(context.globalState.get<boolean>(DISABLED_KEY) ?? false);
    const initialConfig = getConfiguration();
    const getThemeCompatibility = (config: ReturnType<typeof getConfiguration>) => {
        const descriptors = vscode.extensions.all.flatMap(extension => {
            const packageJson: unknown = extension.packageJSON;
            return extractThemeDescriptors(extension.id, packageJson);
        });
        return shouldApplyThemeCompatibility({
            colorTheme: vscode.workspace.getConfiguration('workbench').get<string>('colorTheme') ?? '',
            descriptors,
            mode: config.themeCompatibility
        });
    };
    const syncServerCssConfig = (config: ReturnType<typeof getConfiguration> = getConfiguration()) => {
        const decision = getThemeCompatibility(config);
        server?.updateCssConfig({ customCss: config.customCss, themeCompatibility: decision.enabled });
        output.info('theme-compatibility', `主题兼容模式=${config.themeCompatibility}，当前主题=${decision.theme ?? 'unknown'}，应用=${decision.enabled}（${decision.reason}）`);
        return decision;
    };
    syncServerCssConfig(initialConfig);
    const pendingUninstallCandidate: unknown = context.globalState.get(PENDING_UNINSTALL_KEY);
    let pendingUninstall = isPendingUninstall(pendingUninstallCandidate)
        ? pendingUninstallCandidate
        : undefined;
    const invalidPendingUninstall = pendingUninstallCandidate !== undefined && !pendingUninstall;
    if (pendingUninstallCandidate !== undefined && !pendingUninstall) {
        await context.globalState.update(PENDING_UNINSTALL_KEY, undefined);
        await context.globalState.update(DISABLED_KEY, true);
        lifecycle.setDisabled(true);
        console.warn('[Wallpaper] 丢弃格式无效的 pending uninstall 记录');
    }
    const pendingSetupCandidate: unknown = context.globalState.get(PENDING_SETUP_CONFIRMATION_KEY);
    const pendingSetup = isPendingSetupState(pendingSetupCandidate)
        ? pendingSetupCandidate
        : undefined;
    const invalidPendingSetup = pendingSetupCandidate !== undefined && !pendingSetup;
    const persistedPath = context.globalState.get<string>('currentWallpaperPath');
    const persistedEntry = context.globalState.get<string>('currentWallpaperEntry');
    const supersession = pendingUninstall && pendingSetup
        ? evaluateUninstallSupersession({
            uninstallCreatedAt: pendingUninstall.createdAt,
            setupCreatedAt: pendingSetup.createdAt,
            setupWallpaperId: pendingSetup.wallpaperId,
            currentWallpaperId: initialConfig.wallpaperId,
            setupPath: pendingSetup.dirPath,
            persistedPath,
            setupEntry: pendingSetup.fileName,
            persistedEntry
        })
        : undefined;
    if (pendingUninstall && pendingSetup && supersession?.superseded) {
        const supersededOperationId = pendingUninstall.operationId;
        try {
            await context.globalState.update(PENDING_UNINSTALL_KEY, undefined);
            await context.globalState.update(DISABLED_KEY, false);
            lifecycle.setDisabled(false);
            pendingUninstall = undefined;
            output.info(pendingSetup.operationId, `新设置事务已取代旧还原事务 ${supersededOperationId}`);
        } catch (error) {
            output.error(pendingSetup.operationId, '迁移陈旧还原事务失败', error);
            try {
                await context.globalState.update(PENDING_UNINSTALL_KEY, pendingUninstall);
            } catch (restoreError) {
                output.error(supersededOperationId, '恢复陈旧还原事务记录失败', restoreError);
            }
            await context.globalState.update(DISABLED_KEY, true);
            lifecycle.setDisabled(true);
        }
    }
    if (invalidPendingSetup) {
        await context.globalState.update(PENDING_SETUP_CONFIRMATION_KEY, undefined);
        console.warn('[Wallpaper] 丢弃格式无效的 pending setup 记录');
    }
    let restoredServer = false;
    if (pendingUninstall) {
        lifecycle.setDisabled(true);
        await context.globalState.update(DISABLED_KEY, true);
        const persistedCleared = !context.globalState.get('currentWallpaperPath')
            && !context.globalState.get('currentWallpaperEntry')
            && !context.globalState.get('currentWallpaperLocation')
            && !context.globalState.get(PENDING_SETUP_CONFIRMATION_KEY)
            && !initialConfig.wallpaperId;
        let serverStopped = true;
        try {
            await server.verifyHealth(500);
            serverStopped = false;
        } catch {
            serverStopped = true;
        }
        const verification = verifyUninstallState({
            workbenchRestored: !isPatched(),
            serverStopped,
            transparencyBackupsEmpty: !hasTransparencyBackups(),
            persistedStateCleared: persistedCleared
        });
        if (verification.ok) {
            await context.globalState.update(PENDING_UNINSTALL_KEY, undefined);
            output.info(pendingUninstall.operationId, '卸载还原验证通过');
            vscode.window.setStatusBarMessage('$(check) 壁纸修改已还原', 5000);
            await vscode.window.showInformationMessage('壁纸修改已还原，当前窗口不会再自动注入壁纸。');
        } else {
            output.error(pendingUninstall.operationId, `卸载还原验证失败：${verification.failures.join('；')}`, new Error('重载后状态未完全清理'));
            const action = await vscode.window.showErrorMessage('壁纸修改已部分还原，仍有状态需要清理。', '重试', '查看日志');
            if (action === '重试') {
                await vscode.commands.executeCommand('vscode-wallpaper-engine.uninstallWallpaper');
            } else if (action === '查看日志') {
                output.show();
            }
        }
    }

    let recoveryReloadRequested = false;
    if (!lifecycle.disabled && !pendingUninstall && !invalidPendingUninstall) {
        const savedPath = context.globalState.get<string>('currentWallpaperPath');
        const savedEntry = context.globalState.get<string>('currentWallpaperEntry');
        const savedLocation = context.globalState.get<string>('currentWallpaperLocation');
        if (savedPath) {
            try {
                await server.start(savedPath, initialConfig.serverPort, savedEntry, savedLocation, true);
                await server.verifyHealth();
                restoredServer = true;
            } catch (error) {
                output.error('activation', '恢复壁纸服务失败', error);
            }

            const recoveryNeeded = needsWallpaperInjection({
                disabled: lifecycle.disabled,
                serviceHealthy: restoredServer,
                persistedPath: savedPath,
                persistedEntry: savedEntry,
                workbenchPatched: isPatched()
            });
            if (recoveryNeeded) {
                const savedItem = initialConfig.wallpaperId && initialConfig.workshopPath
                    ? getWallpaperById(initialConfig.workshopPath, initialConfig.wallpaperId)
                    : null;
                if (savedItem) {
                    try {
                        const media = savedItem.getMediaPath();
                        await performInjection(
                            media.path,
                            media.type,
                            initialConfig.opacity,
                            initialConfig.serverPort,
                            initialConfig.resizeDelay,
                            initialConfig.startupCheckInterval,
                            false,
                            SHOW_DEBUG_SIDEBAR
                        );
                        await applyTransparencyPatch();
                        output.info('activation', '检测到 Workbench 注入缺失，已恢复并请求窗口重载');
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                        recoveryReloadRequested = true;
                    } catch (error) {
                        output.error('activation', '恢复 Workbench 壁纸注入失败', error);
                    }
                } else {
                    output.error('activation', '无法定位持久化壁纸媒体', new Error(`wallpaperId=${initialConfig.wallpaperId}`));
                }
            }
        }
    }

    const pendingConfirmation = pendingSetup;
    if (pendingConfirmation && !lifecycle.disabled && !recoveryReloadRequested) {
        const shouldConfirm = shouldConfirmPendingSetup(pendingConfirmation, initialConfig.wallpaperId, Date.now());
        if (restoredServer && shouldConfirm && isPatched()) {
            try {
                await server.verifyHealth(undefined, {
                    rootPath: pendingConfirmation.dirPath,
                    entryFile: pendingConfirmation.fileName
                });
                await server.verifyEntry();
                await context.globalState.update(PENDING_SETUP_CONFIRMATION_KEY, undefined);
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
            const reason = !restoredServer
                ? '服务恢复失败'
                : !isPatched()
                    ? 'Workbench 注入标记不存在'
                    : '壁纸状态未恢复';
            output.error(pendingConfirmation.operationId, '窗口重载后无法确认壁纸生效', new Error(reason));
            SettingsPanel.publishSetupState({
                status: 'error',
                stage: WallpaperSetupStage.ReloadWorkbench,
                message: `窗口重载后未确认壁纸生效（${reason}），请查看日志并重试`
            });
            const action = await vscode.window.showErrorMessage(`壁纸设置已完成，但窗口重载后未确认生效（${reason}）。`, '重试', '查看日志');
            if (action === '重试') {
                await vscode.commands.executeCommand('vscode-wallpaper-engine.setWallpaper');
            } else if (action === '查看日志') {
                output.show();
            }
        } else {
            await context.globalState.update(PENDING_SETUP_CONFIRMATION_KEY, undefined);
            output.info('activation', '丢弃过期、格式无效或已变化的壁纸待确认记录');
        }
    }

    const applyWallpaper = async (forceReload = false, silent = false) => {
        if (lifecycle?.disabled) {
            if (!silent) {
                await vscode.window.showInformationMessage('壁纸修改已还原。请重新执行“设置壁纸”以启用。');
            }
            return;
        }
        if (lifecycle?.currentOperation === 'uninstall') {
            return;
        }
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
                syncServerCssConfig(config);
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

    const applyWallpaperWithLock = async (forceReload = false, silent = true): Promise<void> => {
        if (!lifecycle || !lifecycle.tryBegin('setup')) { return; }
        try {
            await applyWallpaper(forceReload, silent);
        } catch (error) {
            output.error('automatic-apply', '配置变更后自动应用壁纸失败', error);
        } finally {
            lifecycle.end('setup');
        }
    };

    // Watch for config changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
        if (!lifecycle || lifecycle.disabled || lifecycle.currentOperation !== undefined) { return; }
        
        const changedKeys = [
            'wallpaperId', 'workshopPath', 'backgroundOpacity', 'serverPort',
            'resizeDelay', 'startupCheckInterval', 'customCss',
            'transparencyEnabled', 'transparencyRules', 'transparencyBaseColor',
            'themeCompatibility', 'uiLanguage'
        ].filter(key => e.affectsConfiguration(`vscode-wallpaper-engine.${key}`));
        const { wallpaper, transparency } = classifyConfigurationChange(changedKeys);

        if (changedKeys.includes('themeCompatibility')) {
            const config = getConfiguration();
            syncServerCssConfig(config);
            if (server?.getCurrentRoot()) {
                await server.triggerReload();
            }
            await applyTransparencyPatch();
        }
        if (changedKeys.includes('uiLanguage')) {
            SettingsPanel.publishLanguage(getConfiguration().uiLanguage);
        }

        if (wallpaper && changedKeys.length === 1 && changedKeys[0] === 'wallpaperId') {
             const config = getConfiguration();
             if (config.wallpaperId && config.workshopPath) {
                const item = getWallpaperById(config.workshopPath, config.wallpaperId);
                if (item && server) {
                    await applyWallpaperWithLock(false, true);
                    return;
                }
             }
        }

        if (wallpaper) {
            await applyWallpaperWithLock(changedKeys.includes('serverPort'), false);
        } else if (transparency) {
            if (lifecycle.tryBegin('setup')) {
                try {
                    await applyTransparencyPatch();
                } finally {
                    lifecycle.end('setup');
                }
            }
        }
    }));

    // Watch for theme changes to re-apply transparency patch with correct base color
    context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(async () => {
        if (!lifecycle || lifecycle.disabled || lifecycle.currentOperation !== undefined) { return; }
        // Wait a bit for the theme to fully apply
        setTimeout(async () => {
            if (!lifecycle || lifecycle.disabled || lifecycle.currentOperation !== undefined) { return; }
            if (!lifecycle.tryBegin('setup')) { return; }
            try {
                const config = getConfiguration();
                syncServerCssConfig(config);
                if (server?.getCurrentRoot()) {
                    await server.triggerReload();
                }
                await applyTransparencyPatch();
            } finally {
                lifecycle.end('setup');
            }
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
        if (!lifecycle) {
            await vscode.window.showErrorMessage('壁纸生命周期尚未初始化。');
            return;
        }
        if (!lifecycle.tryBegin('setup')) {
            vscode.window.setStatusBarMessage('$(sync~spin) 已有壁纸设置任务正在进行', 3000);
            return;
        }
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
        const operationId = createOperationId();
        try {
            await context.globalState.update(PENDING_UNINSTALL_KEY, undefined);
            if (lifecycle.disabled) {
                lifecycle.setDisabled(false);
                await context.globalState.update(DISABLED_KEY, false);
            }
            output.info(operationId, '用户已选择壁纸，清除旧还原事务并重新启用壁纸功能');
        } catch (error) {
            output.error(operationId, '无法重新启用壁纸状态', error);
            SettingsPanel.publishSetupState({
                status: 'error',
                stage: WallpaperSetupStage.SaveConfiguration,
                message: '无法清除旧还原事务，未启动壁纸设置'
            });
            const action = await vscode.window.showErrorMessage('无法重新启用壁纸状态，未启动壁纸设置。', '重试', '查看日志');
            if (action === '重试') {
                retryRequested = true;
            } else if (action === '查看日志') {
                output.show();
            }
            return;
        }
        const oldWallpaperId = config.wallpaperId;
        const oldWallpaper = oldWallpaperId ? getWallpaperById(config.workshopPath, oldWallpaperId) : null;
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
                        syncServerCssConfig(config);
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
                            syncServerCssConfig(config);
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
            lifecycle.end('setup');
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
            '确定要还原 Wallpaper Engine 的注入和透明化修改吗？扩展仍会保留，但不会再自动应用壁纸。',
            { modal: true },
            '还原修改'
        );
        if (confirm !== '还原修改' || !lifecycle) {
            return;
        }
        if (lifecycle.currentOperation !== undefined) {
            await vscode.window.showWarningMessage('已有壁纸操作正在进行，请完成后再还原。');
            return;
        }
        const operationId = createOperationId();
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在还原壁纸修改',
            cancellable: false
        }, async progress => runUninstall({
            disable: async () => {
                lifecycle?.setDisabled(true);
                await context.globalState.update(DISABLED_KEY, true);
            },
            clearPendingSetup: () => context.globalState.update(PENDING_SETUP_CONFIRMATION_KEY, undefined),
            restoreWorkbench,
            removeTransparency: () => removeTransparencyPatch(),
            stopServer: () => server?.stop() ?? Promise.resolve(),
            clearPersistedState: async () => {
                if (server) {
                    await server.clearPersistedWallpaperState();
                }
                await vscode.workspace.getConfiguration('vscode-wallpaper-engine')
                    .update('wallpaperId', '', vscode.ConfigurationTarget.Global);
            },
            savePendingUninstall: pending => context.globalState.update(PENDING_UNINSTALL_KEY, pending),
            reloadWorkbench: () => vscode.commands.executeCommand('workbench.action.reloadWindow').then(() => undefined),
            report: stage => {
                const message = UNINSTALL_STAGE_MESSAGES[stage];
                progress.report({ message });
                output.info(operationId, `${stage}: ${message}`);
                vscode.window.setStatusBarMessage(`$(sync~spin) ${message}`, 3000);
            },
            createOperationId: () => operationId,
            now: () => Date.now(),
            acquireLock: () => Promise.resolve(lifecycle!.tryBegin('uninstall')),
            releaseLock: () => {
                lifecycle!.end('uninstall');
                return Promise.resolve();
            }
        }));
        if (result.reloaded) {
            return;
        }
        if (result.errors.length === 0) {
            output.info(operationId, '壁纸修改已还原，无需重载');
            await vscode.window.showInformationMessage('壁纸修改已还原。');
        } else {
            result.errors.forEach(error => output.error(operationId, `还原步骤 ${error.stage} 失败`, error));
            const action = await vscode.window.showErrorMessage(
                `壁纸修改已部分还原（${result.errors.length} 个步骤失败）。`,
                '重试',
                '查看日志'
            );
            if (action === '重试') {
                await vscode.commands.executeCommand('vscode-wallpaper-engine.uninstallWallpaper');
            } else if (action === '查看日志') {
                output.show();
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
                syncServerCssConfig({ ...currentConfig, customCss: content });
                server.triggerReload();
                vscode.window.setStatusBarMessage('Wallpaper CSS Updated', 2000);
            }
        }
    }));
}

// This method is called when your extension is deactivated
export async function deactivate() {
    // 窗口重载和扩展宿主重启也会触发 deactivate；这里不能执行用户主动“还原壁纸修改”的清理。
    // Workbench 注入、透明化配置和恢复状态由显式还原命令或设置失败回滚负责。
    console.log('[Wallpaper] 扩展宿主已停用，保留壁纸运行状态。');
}
