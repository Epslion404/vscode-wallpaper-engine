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

export interface TransparencyColorRule {
    key: string;
    labelZh: string;
    labelEn: string;
}

// 【透明化目标列表】覆盖 VS Code Theme Color Reference 中常见的可透明背景项。
const TRANSPARENCY_COLOR_RULES_UNSORTED: readonly TransparencyColorRule[] = [
    { key: 'editor.background', labelZh: '编辑器背景', labelEn: 'Editor background' },
    // VS Code 现代布局使用该通用表面包裹编辑器、侧边栏和面板；不透明主题值会整体遮住壁纸。
    { key: 'surface.background', labelZh: '现代界面基础表面背景', labelEn: 'Modern UI surface background' },
    { key: 'editorGutter.background', labelZh: '编辑器行号与断点边栏背景', labelEn: 'Editor line number and glyph margin background' },
    { key: 'editorPane.background', labelZh: '居中编辑器两侧区域背景', labelEn: 'Editor pane background' },
    { key: 'editor.lineHighlightBackground', labelZh: '当前行高亮背景', labelEn: 'Current line highlight background' },
    { key: 'editor.inactiveLineHighlightBackground', labelZh: '非活动编辑器当前行背景', labelEn: 'Inactive editor line highlight background' },
    { key: 'editor.rangeHighlightBackground', labelZh: '编辑器范围高亮背景', labelEn: 'Editor range highlight background' },
    { key: 'editor.symbolHighlightBackground', labelZh: '符号高亮背景', labelEn: 'Symbol highlight background' },
    { key: 'editorGroup.emptyBackground', labelZh: '空编辑器组背景', labelEn: 'Empty editor group background' },
    { key: 'editorGroup.dropBackground', labelZh: '拖拽编辑器时的背景', labelEn: 'Editor group drag background' },
    { key: 'editorGroup.dropIntoPromptBackground', labelZh: '拖拽提示背景', labelEn: 'Editor drop prompt background' },
    { key: 'editorGroupHeader.tabsBackground', labelZh: '编辑器组标签栏背景', labelEn: 'Editor group tabs background' },
    { key: 'editorGroupHeader.noTabsBackground', labelZh: '单标签编辑器组标题背景', labelEn: 'Editor group header without tabs' },
    { key: 'tab.activeBackground', labelZh: '活动标签页背景', labelEn: 'Active tab background' },
    { key: 'tab.unfocusedActiveBackground', labelZh: '非活动编辑器组的活动标签背景', labelEn: 'Unfocused active tab background' },
    { key: 'tab.inactiveBackground', labelZh: '非活动标签页背景', labelEn: 'Inactive tab background' },
    { key: 'tab.unfocusedInactiveBackground', labelZh: '非活动编辑器组的非活动标签背景', labelEn: 'Unfocused inactive tab background' },
    { key: 'tab.selectedBackground', labelZh: '选中标签页背景', labelEn: 'Selected tab background' },
    { key: 'tab.hoverBackground', labelZh: '悬停标签页背景', labelEn: 'Hovered tab background' },
    { key: 'tab.unfocusedHoverBackground', labelZh: '非活动编辑器组悬停标签背景', labelEn: 'Unfocused hovered tab background' },
    { key: 'sideBar.background', labelZh: '侧边栏背景', labelEn: 'Side bar background' },
    { key: 'sideBar.dropBackground', labelZh: '侧边栏拖拽背景', labelEn: 'Side bar drag background' },
    { key: 'sideBarSectionHeader.background', labelZh: '侧边栏分组标题背景', labelEn: 'Side bar section header background' },
    { key: 'sideBarTitle.background', labelZh: '侧边栏标题背景', labelEn: 'Side bar title background' },
    { key: 'sideBarStickyScroll.background', labelZh: '侧边栏吸附滚动背景', labelEn: 'Side bar sticky scroll background' },
    { key: 'activityBar.background', labelZh: '活动栏背景', labelEn: 'Activity bar background' },
    { key: 'activityBar.activeBackground', labelZh: '活动栏当前项背景', labelEn: 'Activity bar active item background' },
    { key: 'activityBarTop.background', labelZh: '顶部活动栏背景', labelEn: 'Top activity bar background' },
    { key: 'activityBarTop.activeBackground', labelZh: '顶部活动栏当前项背景', labelEn: 'Top activity bar active item background' },
    { key: 'activityBarBadge.background', labelZh: '活动栏徽章背景', labelEn: 'Activity bar badge background' },
    { key: 'activityWarningBadge.background', labelZh: '活动栏警告徽章背景', labelEn: 'Activity warning badge background' },
    { key: 'activityErrorBadge.background', labelZh: '活动栏错误徽章背景', labelEn: 'Activity error badge background' },
    { key: 'panel.background', labelZh: '底部面板背景', labelEn: 'Panel background' },
    { key: 'panelSectionHeader.background', labelZh: '面板分组标题背景', labelEn: 'Panel section header background' },
    { key: 'panelStickyScroll.background', labelZh: '面板吸附滚动背景', labelEn: 'Panel sticky scroll background' },
    { key: 'outputView.background', labelZh: '输出视图背景', labelEn: 'Output view background' },
    { key: 'statusBar.background', labelZh: '状态栏背景', labelEn: 'Status bar background' },
    { key: 'statusBar.debuggingBackground', labelZh: '调试中的状态栏背景', labelEn: 'Debugging status bar background' },
    { key: 'statusBar.noFolderBackground', labelZh: '未打开文件夹时的状态栏背景', labelEn: 'No-folder status bar background' },
    { key: 'statusBarItem.activeBackground', labelZh: '活动状态栏项背景', labelEn: 'Active status bar item background' },
    { key: 'statusBarItem.hoverBackground', labelZh: '悬停状态栏项背景', labelEn: 'Hovered status bar item background' },
    { key: 'statusBarItem.prominentBackground', labelZh: '突出状态栏项背景', labelEn: 'Prominent status bar item background' },
    { key: 'statusBarItem.prominentHoverBackground', labelZh: '悬停突出状态栏项背景', labelEn: 'Hovered prominent status bar item background' },
    { key: 'statusBarItem.remoteBackground', labelZh: '远程状态栏项背景', labelEn: 'Remote status bar item background' },
    { key: 'statusBarItem.errorBackground', labelZh: '错误状态栏项背景', labelEn: 'Error status bar item background' },
    { key: 'statusBarItem.warningBackground', labelZh: '警告状态栏项背景', labelEn: 'Warning status bar item background' },
    { key: 'titleBar.activeBackground', labelZh: '活动窗口标题栏背景', labelEn: 'Active title bar background' },
    { key: 'titleBar.inactiveBackground', labelZh: '非活动窗口标题栏背景', labelEn: 'Inactive title bar background' },
    { key: 'menu.background', labelZh: '菜单背景', labelEn: 'Menu background' },
    { key: 'menu.selectionBackground', labelZh: '菜单选中项背景', labelEn: 'Menu selection background' },
    { key: 'commandCenter.background', labelZh: '命令中心背景', labelEn: 'Command center background' },
    { key: 'commandCenter.activeBackground', labelZh: '命令中心活动背景', labelEn: 'Command center active background' },
    { key: 'commandCenter.debuggingBackground', labelZh: '调试中的命令中心背景', labelEn: 'Debugging command center background' },
    { key: 'notifications.background', labelZh: '通知背景', labelEn: 'Notifications background' },
    { key: 'notificationCenterHeader.background', labelZh: '通知中心标题背景', labelEn: 'Notification center header background' },
    { key: 'debugToolBar.background', labelZh: '调试工具栏背景', labelEn: 'Debug toolbar background' },
    { key: 'quickInput.background', labelZh: '快速输入弹窗背景', labelEn: 'Quick input background' },
    { key: 'quickInputList.focusBackground', labelZh: '快速输入焦点项背景', labelEn: 'Quick input focused item background' },
    { key: 'quickInputTitle.background', labelZh: '快速输入标题背景', labelEn: 'Quick input title background' },
    { key: 'editorWidget.background', labelZh: '编辑器控件背景', labelEn: 'Editor widget background' },
    { key: 'editorSuggestWidget.background', labelZh: '代码建议弹窗背景', labelEn: 'Suggestion widget background' },
    { key: 'editorSuggestWidget.selectedBackground', labelZh: '代码建议选中项背景', labelEn: 'Selected suggestion background' },
    { key: 'editorHoverWidget.background', labelZh: '编辑器悬停提示背景', labelEn: 'Editor hover widget background' },
    { key: 'editorHoverWidget.statusBarBackground', labelZh: '悬停提示状态栏背景', labelEn: 'Editor hover status bar background' },
    { key: 'editorGhostText.background', labelZh: '编辑器幽灵文本背景', labelEn: 'Editor ghost text background' },
    { key: 'editorStickyScroll.background', labelZh: '编辑器吸附滚动背景', labelEn: 'Editor sticky scroll background' },
    { key: 'editorMarkerNavigation.background', labelZh: '编辑器标记导航背景', labelEn: 'Editor marker navigation background' },
    { key: 'peekViewEditor.background', labelZh: 'Peek 编辑器背景', labelEn: 'Peek editor background' },
    { key: 'peekViewEditorGutter.background', labelZh: 'Peek 编辑器边栏背景', labelEn: 'Peek editor gutter background' },
    { key: 'peekViewResult.background', labelZh: 'Peek 结果列表背景', labelEn: 'Peek result background' },
    { key: 'peekViewResult.selectionBackground', labelZh: 'Peek 结果选中项背景', labelEn: 'Peek result selection background' },
    { key: 'peekViewTitle.background', labelZh: 'Peek 标题背景', labelEn: 'Peek title background' },
    { key: 'input.background', labelZh: '输入框背景', labelEn: 'Input background' },
    { key: 'inputOption.activeBackground', labelZh: '输入框活动选项背景', labelEn: 'Active input option background' },
    { key: 'inputOption.hoverBackground', labelZh: '输入框悬停选项背景', labelEn: 'Hovered input option background' },
    { key: 'inputValidation.errorBackground', labelZh: '输入校验错误背景', labelEn: 'Input validation error background' },
    { key: 'inputValidation.warningBackground', labelZh: '输入校验警告背景', labelEn: 'Input validation warning background' },
    { key: 'inputValidation.infoBackground', labelZh: '输入校验信息背景', labelEn: 'Input validation info background' },
    { key: 'dropdown.background', labelZh: '下拉框背景', labelEn: 'Dropdown background' },
    { key: 'dropdown.listBackground', labelZh: '下拉列表背景', labelEn: 'Dropdown list background' },
    { key: 'scrollbar.background', labelZh: '滚动条轨道背景', labelEn: 'Scrollbar background' },
    { key: 'scrollbarSlider.background', labelZh: '滚动条滑块背景', labelEn: 'Scrollbar slider background' },
    { key: 'scrollbarSlider.hoverBackground', labelZh: '悬停滚动条滑块背景', labelEn: 'Hovered scrollbar slider background' },
    { key: 'scrollbarSlider.activeBackground', labelZh: '活动滚动条滑块背景', labelEn: 'Active scrollbar slider background' },
    { key: 'list.activeSelectionBackground', labelZh: '活动列表选中项背景', labelEn: 'Active list selection background' },
    { key: 'list.inactiveSelectionBackground', labelZh: '非活动列表选中项背景', labelEn: 'Inactive list selection background' },
    { key: 'list.focusBackground', labelZh: '列表焦点项背景', labelEn: 'List focused item background' },
    { key: 'list.hoverBackground', labelZh: '列表悬停项背景', labelEn: 'List hover background' },
    { key: 'list.dropBackground', labelZh: '列表拖拽背景', labelEn: 'List drag background' },
    { key: 'tree.tableOddRowsBackground', labelZh: '树表格奇数行背景', labelEn: 'Tree odd-row background' },
    { key: 'minimap.background', labelZh: '最小地图背景', labelEn: 'Minimap background' },
    { key: 'minimapSlider.background', labelZh: '最小地图滑块背景', labelEn: 'Minimap slider background' },
    { key: 'minimapSlider.hoverBackground', labelZh: '悬停最小地图滑块背景', labelEn: 'Hovered minimap slider background' },
    { key: 'minimapSlider.activeBackground', labelZh: '活动最小地图滑块背景', labelEn: 'Active minimap slider background' },
    { key: 'terminal.background', labelZh: '集成终端背景', labelEn: 'Integrated terminal background' },
    { key: 'terminal.selectionBackground', labelZh: '终端选区背景', labelEn: 'Terminal selection background' },
    { key: 'terminal.inactiveSelectionBackground', labelZh: '非活动终端选区背景', labelEn: 'Inactive terminal selection background' },
    { key: 'terminal.dropBackground', labelZh: '终端拖拽背景', labelEn: 'Terminal drag background' },
    { key: 'terminalStickyScroll.background', labelZh: '终端吸附滚动背景', labelEn: 'Terminal sticky scroll background' },
    { key: 'welcomePage.background', labelZh: '欢迎页背景', labelEn: 'Welcome page background' },
    { key: 'welcomePage.tileBackground', labelZh: '欢迎页磁贴背景', labelEn: 'Welcome page tile background' },
    { key: 'welcomePage.tileHoverBackground', labelZh: '欢迎页悬停磁贴背景', labelEn: 'Welcome page hovered tile background' },
    { key: 'settings.dropdownBackground', labelZh: '设置下拉框背景', labelEn: 'Settings dropdown background' },
    { key: 'settings.rowHoverBackground', labelZh: '设置行悬停背景', labelEn: 'Settings row hover background' },
    { key: 'settings.textInputBackground', labelZh: '设置文本输入框背景', labelEn: 'Settings text input background' },
    { key: 'settings.numberInputBackground', labelZh: '设置数字输入框背景', labelEn: 'Settings number input background' },
    { key: 'settings.focusedRowBackground', labelZh: '设置焦点行背景', labelEn: 'Settings focused row background' },
    { key: 'chat.requestBackground', labelZh: '聊天请求背景', labelEn: 'Chat request background' },
    { key: 'chat.slashCommandBackground', labelZh: '聊天斜杠命令背景', labelEn: 'Chat slash command background' },
    { key: 'chat.avatarBackground', labelZh: '聊天头像背景', labelEn: 'Chat avatar background' },
    { key: 'chat.requestBubbleBackground', labelZh: '聊天请求气泡背景', labelEn: 'Chat request bubble background' },
    { key: 'chat.requestBubbleHoverBackground', labelZh: '悬停聊天请求气泡背景', labelEn: 'Hovered chat request bubble background' },
    { key: 'inlineChat.background', labelZh: '内联聊天控件背景', labelEn: 'Inline chat background' },
    { key: 'inlineChatInput.background', labelZh: '内联聊天输入框背景', labelEn: 'Inline chat input background' },
    { key: 'diffEditor.insertedTextBackground', labelZh: '差异编辑器新增文本背景', labelEn: 'Diff inserted text background' },
    { key: 'diffEditor.removedTextBackground', labelZh: '差异编辑器删除文本背景', labelEn: 'Diff removed text background' },
    { key: 'diffEditor.insertedLineBackground', labelZh: '差异编辑器新增行背景', labelEn: 'Diff inserted line background' },
    { key: 'diffEditor.removedLineBackground', labelZh: '差异编辑器删除行背景', labelEn: 'Diff removed line background' },
    { key: 'diffEditor.unchangedRegionBackground', labelZh: '差异编辑器未变更区域背景', labelEn: 'Diff unchanged region background' },
    { key: 'multiDiffEditor.headerBackground', labelZh: '多文件差异标题背景', labelEn: 'Multi diff header background' },
    { key: 'multiDiffEditor.background', labelZh: '多文件差异编辑器背景', labelEn: 'Multi diff editor background' },
    { key: 'merge.currentHeaderBackground', labelZh: '合并冲突当前标题背景', labelEn: 'Merge current header background' },
    { key: 'merge.currentContentBackground', labelZh: '合并冲突当前内容背景', labelEn: 'Merge current content background' },
    { key: 'merge.incomingHeaderBackground', labelZh: '合并冲突传入标题背景', labelEn: 'Merge incoming header background' },
    { key: 'merge.incomingContentBackground', labelZh: '合并冲突传入内容背景', labelEn: 'Merge incoming content background' },
    { key: 'merge.commonHeaderBackground', labelZh: '合并冲突共同祖先标题背景', labelEn: 'Merge common header background' },
    { key: 'merge.commonContentBackground', labelZh: '合并冲突共同内容背景', labelEn: 'Merge common content background' },
    { key: 'mergeEditor.change.background', labelZh: '合并编辑器变更背景', labelEn: 'Merge editor change background' },
    { key: 'mergeEditor.changeBase.background', labelZh: '合并编辑器基线变更背景', labelEn: 'Merge editor base change background' },
];

const TRANSPARENCY_POPULARITY_ORDER = [
    'editor.background',
    'surface.background',
    'editorGutter.background',
    'sideBar.background',
    'panel.background',
    'terminal.background',
    'editorGroupHeader.tabsBackground',
    'tab.activeBackground',
    'tab.inactiveBackground',
    'activityBar.background',
    'statusBar.background',
    'titleBar.activeBackground',
    'minimap.background',
    'editorPane.background',
    'editorGroup.emptyBackground',
    'input.background',
    'menu.background',
    'quickInput.background',
    'editorWidget.background',
    'list.activeSelectionBackground',
    'settings.textInputBackground',
] as const;

const transparencyPopularity = new Map<string, number>(
    TRANSPARENCY_POPULARITY_ORDER.map((key, index) => [key, index]),
);

// 默认按常用程度排序；未列入热门清单的规则保持原有分组顺序。
export const TRANSPARENCY_COLOR_RULES: readonly TransparencyColorRule[] = [...TRANSPARENCY_COLOR_RULES_UNSORTED].sort((left, right) => {
    const leftRank = transparencyPopularity.get(left.key) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = transparencyPopularity.get(right.key) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
});

export const TRANSPARENT_COLOR_KEYS = TRANSPARENCY_COLOR_RULES.map(rule => rule.key);

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
