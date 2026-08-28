import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    applyManagedColors,
    ColorCustomizations,
    ManagedColorBackups,
    restoreManagedColors
} from './transparency-state';

const TRANSPARENCY_BACKUP_KEY = 'transparencyColorBackups';
const TRANSPARENCY_WORKSPACE_FOLDER_BACKUP_KEY = 'transparencyColorBackups.workspaceFolder';
let globalState: vscode.Memento | undefined;
let workspaceState: vscode.Memento | undefined;

export type TransparencyPatchTarget =
    | vscode.ConfigurationTarget.Global
    | vscode.ConfigurationTarget.Workspace
    | vscode.ConfigurationTarget.WorkspaceFolder;

/** 将单一作用域参数规范化为有序、去重的作用域列表。 */
export function normalizeTransparencyTargets(
    target?: TransparencyPatchTarget | readonly TransparencyPatchTarget[]
): TransparencyPatchTarget[] {
    const targets = target === undefined
        ? [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.WorkspaceFolder]
        : Array.isArray(target) ? target : [target];
    return [...new Set(targets)];
}

export function initializeTransparencyState(context: vscode.ExtensionContext): void {
    globalState = context.globalState;
    workspaceState = context.workspaceState;
}

/** 返回所有配置作用域是否仍存在插件托管的颜色备份。 */
export function hasTransparencyBackups(): boolean {
    const globalBackups = globalState?.get<ManagedColorBackups>(TRANSPARENCY_BACKUP_KEY) || {};
    const workspaceBackups = workspaceState?.get<ManagedColorBackups>(TRANSPARENCY_BACKUP_KEY) || {};
    const workspaceFolderBackups = workspaceState?.get<ManagedColorBackups>(TRANSPARENCY_WORKSPACE_FOLDER_BACKUP_KEY) || {};
    return Object.keys(globalBackups).length > 0 || Object.keys(workspaceBackups).length > 0 || Object.keys(workspaceFolderBackups).length > 0;
}

// 【透明化目标列表】所有可能遮挡壁纸的 UI 元素 Key
export const TRANSPARENT_COLOR_KEYS = [
    // 核心区域
    "editor.background",
    "editorGroup.emptyBackground",
    "editorGroupHeader.tabsBackground",
    "terminal.background",

    // 侧边栏/面板
    "sideBar.background",
    "sideBarSectionHeader.background",
    "panel.background",
    "activityBar.background",
    
    // 标题栏
    "titleBar.activeBackground",
    "titleBar.inactiveBackground",

    // 标签页
    "tab.inactiveBackground",
    "tab.activeBackground",
    "tab.unfocusedActiveBackground",
    "tab.hoverBackground",
    "tab.unfocusedHoverBackground",

    // 状态栏
    "statusBar.background",
    "statusBar.debuggingBackground",
    "statusBar.noFolderBackground",
    "statusBarItem.hoverBackground",
    "statusBarItem.remoteBackground",
    "statusBarItem.prominentBackground",

    // 弹窗/菜单/输入框
    "menu.background",
    "quickInput.background",
    "editorWidget.background",
    "debugToolBar.background",
    "notifications.background",
    "notificationCenterHeader.background",
    "peekViewEditor.background",
    "peekViewResult.background",
    
    // 控件背景
    "dropdown.background",
    "dropdown.listBackground",
    "input.background",
    "settings.dropdownBackground",
    "welcomePage.tileBackground"
];

/**
 * 自动将 VS Code UI 关键元素的背景色设置为完全透明。
 * @param target 目标配置作用域 (Global、Workspace 或 WorkspaceFolder)
 */
export async function applyTransparencyPatch(target?: TransparencyPatchTarget, resource?: vscode.Uri) {
    const resolvedTarget = target ?? getPreferredTransparencyTarget(resource);
    const configurationResource = resource ?? getConfigurationResource();
    const config = vscode.workspace.getConfiguration(undefined, configurationResource);
    const enabled = config.get<boolean>('vscode-wallpaper-engine.transparencyEnabled') ?? true;

    if (!enabled) {
        await removeTransparencyPatch(resolvedTarget, configurationResource);
        return;
    }

    const rules = config.get<{[key: string]: number}>('vscode-wallpaper-engine.transparencyRules') || {};

    // 1. 获取现有颜色自定义设置
    const existingCustomizations = getTargetCustomizations(config, resolvedTarget);

    // logging 
    console.log("[CUSTOM COLOR] Existing Customizations:", existingCustomizations);
    console.log("[CUSTOM COLOR] Managed target:", resolvedTarget);

    // 获取当前主题类型 (Light/Dark)
    const isLightTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light;
    let defaultBaseColor = isLightTheme ? '#FFFFFF' : '#000000';

    // 检查是否有用户配置的基底颜色
    const configuredBaseColor = config.get<string>('vscode-wallpaper-engine.transparencyBaseColor');
    if (configuredBaseColor && /^#[0-9A-Fa-f]{6}$/.test(configuredBaseColor)) {
        defaultBaseColor = configuredBaseColor;
    }

    // 尝试加载当前激活主题的原始 colors（从主题扩展的 JSON 文件）
    const themeColors = await loadActiveThemeColors();

    const desiredCustomizations: ColorCustomizations = {};
    for (const key of TRANSPARENT_COLOR_KEYS) {
        if (rules[key] !== undefined) {
            // 启用：设置颜色
            // 限制 opacity 在 0-1 之间
            let opacity = rules[key];
            if (opacity < 0) { opacity = 0; }
            if (opacity > 1) { opacity = 1; }
            
            // 计算 Hex Alpha (00-FF)
            const alpha = Math.round(opacity * 255).toString(16).padStart(2, '0');
            
            // 确定基色 (Base Color)
            let baseColor = defaultBaseColor;

            // 优先级策略：
            // 1. 用户配置的 transparencyBaseColor
            if (configuredBaseColor && /^#[0-9A-Fa-f]{6}$/.test(configuredBaseColor)) {
                baseColor = configuredBaseColor;
            }
            // 2. 尝试使用 user 在 settings.json 中对该 key 的自定义颜色
            else {
                const currentVal = existingCustomizations[key];
                if (typeof currentVal === 'string' && currentVal.startsWith('#')) {
                    // 简单的 Hex 解析
                    if (currentVal.length === 7) { // #RRGGBB
                        baseColor = currentVal;
                    } else if (currentVal.length === 9) { // #RRGGBBAA
                        baseColor = currentVal.substring(0, 7);
                    } else if (currentVal.length === 4) { // #RGB
                        const r = currentVal[1];
                        const g = currentVal[2];
                        const b = currentVal[3];
                        baseColor = `#${r}${r}${g}${g}${b}${b}`;
                    } else if (currentVal.length === 5) { // #RGBA
                        const r = currentVal[1];
                        const g = currentVal[2];
                        const b = currentVal[3];
                        baseColor = `#${r}${r}${g}${g}${b}${b}`;
                    }
                }

                // 3. 尝试从激活主题中获取该 key 的颜色
                if ((!baseColor || baseColor === defaultBaseColor) && themeColors && themeColors[key]) {
                    const tc = normalizeColorString(themeColors[key]);
                    if (tc) {
                        baseColor = tc;
                    }
                }
            }

            desiredCustomizations[key] = `${baseColor}${alpha}`;
        }
    }

    const state = getState(resolvedTarget);
    const backupKey = getBackupKey(resolvedTarget);
    const backups = state?.get<ManagedColorBackups>(backupKey) || {};
    const result = applyManagedColors(existingCustomizations, desiredCustomizations, backups);

    // 4. 检查是否有变更 (避免重复更新导致闪烁或死循环)
    if (JSON.stringify(existingCustomizations) === JSON.stringify(result.customizations)) {
        await state?.update(backupKey, result.backups);
        return;
    }

    // 5. 更新设置
    try {
        await config.update('workbench.colorCustomizations', result.customizations, resolvedTarget);
        await state?.update(backupKey, result.backups);
        vscode.window.setStatusBarMessage('✅ UI Transparency Updated', 2000);
    } catch (error) {
        vscode.window.showErrorMessage('❌ 无法自动修改 settings.json。');
        console.error("Settings update failed:", error);
    }
}

/**
 * 移除我们设置的所有透明度规则。
 * 未指定作用域时会清理 Global、Workspace 与 WorkspaceFolder；传入单个作用域可用于
 * 设置变更回滚等局部操作。
 */
export async function removeTransparencyPatch(
    target?: TransparencyPatchTarget | readonly TransparencyPatchTarget[],
    resource?: vscode.Uri
) {
    const targets = normalizeTransparencyTargets(target);
    const failures: Array<{ target: TransparencyPatchTarget; error: unknown }> = [];

    // 每个作用域独立处理，保证一个 settings.json 写入失败不会跳过另一个作用域。
    for (const scope of targets) {
        try {
            await removeTransparencyPatchForTarget(scope, resource);
        } catch (error) {
            failures.push({ target: scope, error });
            console.error(`[Transparency] Failed to remove ${scope} patch:`, error);
        }
    }

    if (failures.length > 0) {
        throw new TransparencyPatchRemovalError(failures);
    }
}

export class TransparencyPatchRemovalError extends Error {
    public constructor(
        public readonly failures: ReadonlyArray<{ target: TransparencyPatchTarget; error: unknown }>
    ) {
        super(`透明化配置移除失败（${failures.length} 个作用域）`);
        this.name = 'TransparencyPatchRemovalError';
    }
}

/** 选择当前资源实际使用的规则配置作用域，避免 Global 写入被文件夹级设置覆盖。 */
export function getPreferredTransparencyTarget(resource?: vscode.Uri): TransparencyPatchTarget {
    return getPreferredConfigurationTarget('transparencyRules', resource);
}

/** 读取指定扩展配置的最高优先级作用域，支持工作区文件夹设置。 */
export function getPreferredConfigurationTarget(section: string, resource?: vscode.Uri): TransparencyPatchTarget {
    const configurationResource = resource ?? getConfigurationResource();
    const inspect = vscode.workspace
        .getConfiguration('vscode-wallpaper-engine', configurationResource)
        .inspect(section);
    if (inspect?.workspaceFolderValue !== undefined) {
        return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (inspect?.workspaceValue !== undefined) {
        return vscode.ConfigurationTarget.Workspace;
    }
    return vscode.ConfigurationTarget.Global;
}

async function removeTransparencyPatchForTarget(target: TransparencyPatchTarget, resource?: vscode.Uri): Promise<void> {
    const config = vscode.workspace.getConfiguration(undefined, resource ?? getConfigurationResource());
    const existingCustomizations = getTargetCustomizations(config, target);
    const state = getState(target);
    const backupKey = getBackupKey(target);
    const backups = state?.get<ManagedColorBackups>(backupKey) || {};
    const restoredCustomizations = restoreManagedColors(existingCustomizations, backups);
    const finalSettings = Object.keys(restoredCustomizations).length === 0 ? undefined : restoredCustomizations;

    if (Object.keys(backups).length > 0) {
        await config.update('workbench.colorCustomizations', finalSettings, target);
        await state?.update(backupKey, undefined);
        vscode.window.setStatusBarMessage('UI Transparency Removed', 2000);
    }
}

function getState(target: vscode.ConfigurationTarget): vscode.Memento | undefined {
    return target === vscode.ConfigurationTarget.Global ? globalState : workspaceState;
}

function getBackupKey(target: TransparencyPatchTarget): string {
    return target === vscode.ConfigurationTarget.WorkspaceFolder
        ? TRANSPARENCY_WORKSPACE_FOLDER_BACKUP_KEY
        : TRANSPARENCY_BACKUP_KEY;
}

function getConfigurationResource(): vscode.Uri | undefined {
    const activeDocument = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeDocument ? vscode.workspace.getWorkspaceFolder(activeDocument) : undefined;
    if (activeFolder) {
        return activeFolder.uri;
    }
    if (vscode.workspace.workspaceFolders?.length === 1) {
        return vscode.workspace.workspaceFolders[0].uri;
    }
    return undefined;
}

function getTargetCustomizations(
    config: vscode.WorkspaceConfiguration,
    target: vscode.ConfigurationTarget
): ColorCustomizations {
    const inspected = config.inspect<ColorCustomizations>('workbench.colorCustomizations');
    if (target === vscode.ConfigurationTarget.WorkspaceFolder) {
        return inspected?.workspaceFolderValue || {};
    }
    if (target === vscode.ConfigurationTarget.Workspace) {
        return inspected?.workspaceValue || {};
    }
    return inspected?.globalValue || {};
}

    // ---- Helper: 解析并返回激活主题的 colors 对象（如果能找到） ----
    let _cachedThemeName: string | undefined = undefined;
    let _cachedThemeColors: { [key: string]: string } | undefined = undefined;

    async function loadActiveThemeColors(): Promise<{ [key: string]: string } | undefined> {
        try {
                const themeName = (vscode.workspace.getConfiguration('workbench').get('colorTheme') as string);
                if (!themeName) { return undefined; }

                if (_cachedThemeName === themeName && _cachedThemeColors) {
                    return _cachedThemeColors;
                }

            // 遍历已安装扩展，寻找贡献 theme 的扩展
            for (const ext of vscode.extensions.all) {
                const contributes = ext.packageJSON && ext.packageJSON.contributes;
                if (!contributes || !contributes.themes) { continue; }

                const themes = contributes.themes;
                for (const t of themes) {
                    const labels = [t.label, t.id, t.name].filter(Boolean).map(String);
                    if (labels.includes(themeName)) {
                        // 找到对应主题文件
                        const themePath = t.path || t.theme || t.file;
                        if (!themePath) { continue; }
                        const abs = path.isAbsolute(themePath) ? themePath : path.join(ext.extensionPath, themePath);
                        try {
                            const raw = fs.readFileSync(abs, 'utf8');
                            const json = JSON.parse(raw);
                            const colors = json.colors || json['workbench.colorCustomizations'] || undefined;
                            if (colors && typeof colors === 'object') {
                                _cachedThemeName = themeName;
                                _cachedThemeColors = colors;
                                return colors;
                            }
                        } catch (e) {
                            // ignore parse/read errors and continue
                            continue;
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to load active theme colors:', e);
        }
        return undefined;
    }

    // ---- Helper: 规范化颜色字符串，返回 #RRGGBB 或 undefined ----
    function normalizeColorString(input: unknown): string | undefined {
        if (!input || typeof input !== 'string') { return undefined; }
        const value = input.trim();
        // Hex #RRGGBB or #RGB or #RRGGBBAA
        if (/^#[0-9A-Fa-f]{6}$/.test(value)) { return value.toUpperCase(); }
        if (/^#[0-9A-Fa-f]{3}$/.test(value)) {
            const r = value[1];
            const g = value[2];
            const b = value[3];
            return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
        }
        if (/^#[0-9A-Fa-f]{8}$/.test(value)) {
            return value.substring(0, 7).toUpperCase();
        }
        // rgba(...) or rgb(...)
        const rgba = value.match(/rgba?\(([^)]+)\)/i);
        if (rgba) {
            const parts = rgba[1].split(',').map((p: string) => p.trim());
            if (parts.length >= 3) {
                const r = Math.max(0, Math.min(255, parseInt(parts[0], 10) || 0));
                const g = Math.max(0, Math.min(255, parseInt(parts[1], 10) || 0));
                const b = Math.max(0, Math.min(255, parseInt(parts[2], 10) || 0));
                const toHex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
                return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
            }
        }
        // Unknown format
        return undefined;
    }
