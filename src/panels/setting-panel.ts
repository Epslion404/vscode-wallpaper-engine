import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WallpaperServer } from '../core/server';
import { TRANSPARENT_COLOR_KEYS, applyTransparencyPatch, getPreferredConfigurationTarget, getPreferredTransparencyTarget } from '../core/config-patcher';
import { WallpaperSetupViewState } from '../core/wallpaper-setup';
import { toUserErrorReason } from '../core/user-message';
import { isUiLanguage, resolveUiLanguage, UiLanguage } from './localization';
import { ThemeCompatibilityMode, ThemeCompatibilityDecision } from '../core/theme-compatibility';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function getSettingsResource(): vscode.Uri | undefined {
    return vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function getSettingsConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('vscode-wallpaper-engine', getSettingsResource());
}

export type SettingsPanelMessage =
    | { command: 'ready' }
    | { command: 'refresh' }
    | { command: 'switch' }
    | { command: 'openBrowser' }
    | { command: 'openFolder' }
    | { command: 'stopServer' }
    | { command: 'editCustomCss' }
    | { command: 'updateProp'; key: string; value: JsonValue }
    | { command: 'updateGeneral'; key: string; value: JsonValue }
    | { command: 'updateCss'; customCss: string }
    | { command: 'updateTransparencyRules'; rules: Record<string, number> }
    | { command: 'toggleTransparency'; enabled: boolean }
    | { command: 'updateTransparencyBaseColor'; color: string }
    | { command: 'setLanguage'; language: UiLanguage };

export interface ThemeCompatibilityViewState extends ThemeCompatibilityDecision {
    mode: ThemeCompatibilityMode;
}

type CommandWithoutPayload = Extract<SettingsPanelMessage, { command:
    | 'ready'
    | 'refresh'
    | 'switch'
    | 'openBrowser'
    | 'openFolder'
    | 'stopServer'
    | 'editCustomCss'
}>['command'];

const COMMANDS_WITHOUT_PAYLOAD = new Set<string>([
    'ready',
    'refresh',
    'switch',
    'openBrowser',
    'openFolder',
    'stopServer',
    'editCustomCss',
]);

function isCommandWithoutPayload(command: string): command is CommandWithoutPayload {
    return COMMANDS_WITHOUT_PAYLOAD.has(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }
    if (isRecord(value)) {
        return Object.keys(value).every((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && isJsonValue(value[key]));
    }
    return false;
}

function isSafeKey(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 && value !== '__proto__' && value !== 'constructor' && value !== 'prototype';
}

function isTransparencyRules(value: unknown): value is Record<string, number> {
    if (!isRecord(value)) {
        return false;
    }
    return Object.keys(value).every((key) => {
        const ruleValue = value[key];
        return isSafeKey(key) && typeof ruleValue === 'number' && Number.isFinite(ruleValue) && ruleValue >= 0 && ruleValue <= 1;
    });
}

/** 将 Webview 外部消息解析为受约束的命令联合类型；非法消息直接丢弃。 */
export function parseSettingsPanelMessage(message: unknown): SettingsPanelMessage | undefined {
    if (!isRecord(message) || typeof message.command !== 'string') {
        return undefined;
    }

    const command = message.command;
    if (isCommandWithoutPayload(command)) {
        return { command };
    }
    if (command === 'updateProp' || command === 'updateGeneral') {
        if (!isSafeKey(message.key) || !isJsonValue(message.value)) {
            return undefined;
        }
        return { command, key: message.key, value: message.value };
    }
    if (command === 'updateCss') {
        return typeof message.customCss === 'string' ? { command, customCss: message.customCss } : undefined;
    }
    if (command === 'updateTransparencyRules') {
        return isTransparencyRules(message.rules) ? { command, rules: message.rules } : undefined;
    }
    if (command === 'toggleTransparency') {
        return typeof message.enabled === 'boolean' ? { command, enabled: message.enabled } : undefined;
    }
    if (command === 'updateTransparencyBaseColor') {
        return typeof message.color === 'string' ? { command, color: message.color } : undefined;
    }
    if (command === 'setLanguage') {
        return isUiLanguage(message.language) ? { command, language: message.language } : undefined;
    }
    return undefined;
}

export class SettingsPanel {
    public static currentPanel: SettingsPanel | undefined;
    private static setupState: WallpaperSetupViewState = { status: 'idle', message: '等待操作' };
    private static compatibilityState: ThemeCompatibilityViewState = {
        mode: 'auto', enabled: false, reason: 'not-detected', theme: ''
    };
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private server: WallpaperServer) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, extensionUri);
        this._setWebviewMessageListener(this._panel.webview);
    }

    public static createOrShow(extensionUri: vscode.Uri, server: WallpaperServer) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'wallpaperSettings',
            'Wallpaper Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, server);
    }

    public static publishSetupState(state: WallpaperSetupViewState): void {
        SettingsPanel.setupState = state;
        void SettingsPanel.currentPanel?._panel.webview.postMessage({ type: 'setupState', state });
    }

    public static publishLanguage(language: UiLanguage): void {
        const resolved = resolveUiLanguage(language, vscode.env.language);
        void SettingsPanel.currentPanel?._panel.webview.postMessage({ type: 'language', language, resolvedLanguage: resolved });
    }

    public static publishCompatibilityStatus(state: ThemeCompatibilityViewState): void {
        SettingsPanel.compatibilityState = state;
        void SettingsPanel.currentPanel?._panel.webview.postMessage({ type: 'compatibilityStatus', state });
    }

    public dispose() {
        SettingsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(
            async (rawMessage: unknown) => {
                const message = parseSettingsPanelMessage(rawMessage);
                if (!message) {
                    console.warn('[Panel] Ignoring malformed webview message');
                    return;
                }
                if (message.command === 'updateProp') {
                    this.server.broadcast({
                        type: 'UPDATE_PROPERTIES',
                        data: { [message.key]: { value: message.value } }
                    });
                } else if (message.command === 'ready') {
                    await webview.postMessage({ type: 'setupState', state: SettingsPanel.setupState });
                    await webview.postMessage({ type: 'compatibilityStatus', state: SettingsPanel.compatibilityState });
                    const configured = getSettingsConfiguration().get<unknown>('uiLanguage');
                    const language = isUiLanguage(configured) ? configured : 'auto';
                    await webview.postMessage({ type: 'language', language, resolvedLanguage: resolveUiLanguage(language, vscode.env.language) });
                } else if (message.command === 'setLanguage') {
                    try {
                        await getSettingsConfiguration()
                            .update('uiLanguage', message.language, vscode.ConfigurationTarget.Global);
                        SettingsPanel.publishLanguage(message.language);
                    } catch (error: unknown) {
                        console.error('[Panel] Failed to save UI language:', error);
                        await vscode.window.showErrorMessage(`保存界面语言失败：${toUserErrorReason(error)}`);
                    }
                } else if (message.command === 'updateGeneral') {
                    // Handle general settings (audio, mic, etc.)
                    // We'll send a specific message type for these
                    this.server.broadcast({
                        type: 'UPDATE_GENERAL',
                        data: { [message.key]: message.value }
                    });
                } else if (message.command === 'refresh') {
                    vscode.commands.executeCommand('vscode-wallpaper-engine.refreshWallpaper');
                } else if (message.command === 'switch') {
                    vscode.commands.executeCommand('vscode-wallpaper-engine.setWallpaper');
                } else if (message.command === 'openBrowser') {
                    vscode.commands.executeCommand('vscode-wallpaper-engine.openInBrowser');
                } else if (message.command === 'openFolder') {
                    const root = this.server.getCurrentRoot();
                    if (root) {
                        await vscode.env.openExternal(vscode.Uri.file(root));
                    } else {
                        await vscode.window.showErrorMessage('当前没有已加载的壁纸。');
                    }
                } else if (message.command === 'stopServer') {
                    try {
                        await this.server.stop();
                        await vscode.window.showWarningMessage('壁纸服务已停止。');
                    } catch (error: unknown) {
                        console.error('[Panel] Failed to stop wallpaper server:', error);
                        await vscode.window.showErrorMessage(`停止壁纸服务失败：${toUserErrorReason(error)}`);
                    }
                } else if (message.command === 'editCustomCss') {
                    await vscode.commands.executeCommand('vscode-wallpaper-engine.editCustomCss');
                } else if (message.command === 'updateCss') {
                    const config = getSettingsConfiguration();

                    try {
                        await config.update('customCss', message.customCss, vscode.ConfigurationTarget.Global);
                    } catch (error: unknown) {
                        console.error('[Panel] Failed to save custom CSS:', error);
                        await vscode.window.showErrorMessage(`保存自定义样式失败：${toUserErrorReason(error)}`);
                        return;
                    }

                    this.server.updateCssConfig({
                        customCss: message.customCss
                    });

                    try {
                        console.log('[Panel] Waiting for the wallpaper client to confirm the CSS reload');
                        await this.server.triggerReloadAndWait();
                        await vscode.window.showInformationMessage('自定义样式已保存并应用。');
                    } catch (error: unknown) {
                        console.error('[Panel] Wallpaper client did not confirm the CSS reload:', error);
                        await vscode.window.showWarningMessage('自定义样式已保存，但壁纸客户端未确认刷新，请手动刷新壁纸。');
                    }
                } else if (message.command === 'updateTransparencyRules') {
                    const config = getSettingsConfiguration();
                    try {
                        const target = getPreferredTransparencyTarget();
                        await config.update('transparencyRules', message.rules, target);
                        await applyTransparencyPatch(target);
                        const persistedRules = config.get<Record<string, number>>('transparencyRules') || {};
                        await this._panel.webview.postMessage({ type: 'transparencyRules', rules: persistedRules });
                        await vscode.window.showInformationMessage('透明化规则已更新。');
                    } catch (error: unknown) {
                        console.error('[Panel] Failed to update transparency rules:', error);
                        await vscode.window.showErrorMessage(`更新透明化规则失败：${toUserErrorReason(error)}`);
                    }
                } else if (message.command === 'toggleTransparency') {
                    const config = getSettingsConfiguration();
                    try {
                        const target = getPreferredConfigurationTarget('transparencyEnabled');

                        await config.update('transparencyEnabled', message.enabled, target);
                        await applyTransparencyPatch(target);
                        await vscode.window.showInformationMessage(`透明化已${message.enabled ? '启用' : '关闭'}。`);
                    } catch (error: unknown) {
                        console.error('[Panel] Failed to toggle transparency:', error);
                        await vscode.window.showErrorMessage(`切换透明化失败：${toUserErrorReason(error)}`);
                    }
                } else if (message.command === 'updateTransparencyBaseColor') {
                    const config = getSettingsConfiguration();
                    try {
                        const target = getPreferredConfigurationTarget('transparencyBaseColor');

                        await config.update('transparencyBaseColor', message.color, target);
                        await applyTransparencyPatch(target);
                        await vscode.window.showInformationMessage('透明化基色已更新。');
                    } catch (error: unknown) {
                        console.error('[Panel] Failed to update transparency base color:', error);
                        await vscode.window.showErrorMessage(`更新透明化基色失败：${toUserErrorReason(error)}`);
                    }
                }
            },
            undefined,
            this._disposables
        );
    }

    private _getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri) {
        const config = getSettingsConfiguration();
        const port = config.get<number>('serverPort') || 23333;
        const customCss = config.get<string>('customCss') || '';
        const transparencyRules = config.get<Record<string, number>>('transparencyRules') || {};
        const transparencyEnabled = config.get<boolean>('transparencyEnabled') ?? true;
        const transparencyBaseColor = config.get<string>('transparencyBaseColor') || '';
        const configuredLanguage = config.get<unknown>('uiLanguage');
        const uiLanguage = isUiLanguage(configuredLanguage) ? configuredLanguage : 'auto';

        const info = this.server.getCurrentInfo();
        const infoPath = info.root || 'None';
        const infoEntry = info.entry || 'None';
        const infoName = infoPath !== 'None' ? path.basename(infoPath) : 'None';
        const infoType = infoEntry !== 'None' ? path.extname(infoEntry).toUpperCase().replace('.', '') : 'None';

        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'settings.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'settings.css'));
        const htmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'settings.html');
        
        let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf-8');

        // Escape special characters for HTML attribute
        const escapeHtml = (unsafe: string) => {
            return unsafe
                 .replace(/&/g, "&amp;")
                 .replace(/</g, "&lt;")
                 .replace(/>/g, "&gt;")
                 .replace(/"/g, "&quot;")
                 .replace(/'/g, "&#039;");
         };

        htmlContent = htmlContent
            .replace(/{{infoName}}/g, escapeHtml(infoName))
            .replace(/{{infoType}}/g, escapeHtml(infoType))
            .replace(/{{infoEntry}}/g, escapeHtml(infoEntry))
            .replace(/{{infoPath}}/g, escapeHtml(infoPath))
            .replace(/{{cspSource}}/g, webview.cspSource)
            .replace(/{{styleUri}}/g, styleUri.toString())
            .replace(/{{scriptUri}}/g, scriptUri.toString())
            .replace(/{{serverPort}}/g, port.toString())
            .replace(/{{customCss}}/g, escapeHtml(customCss))
            .replace(/{{transparencyKeys}}/g, JSON.stringify(TRANSPARENT_COLOR_KEYS))
            .replace(/{{transparencyRules}}/g, JSON.stringify(transparencyRules))
            .replace(/{{transparencyEnabled}}/g, JSON.stringify(transparencyEnabled))
            .replace(/{{transparencyBaseColor}}/g, escapeHtml(transparencyBaseColor))
            .replace(/{{uiLanguage}}/g, JSON.stringify(uiLanguage))
            .replace(/{{themeCompatibilityState}}/g, JSON.stringify(SettingsPanel.compatibilityState));

        return htmlContent;
    }
}
