export type ThemeCompatibilityMode = 'auto' | 'on' | 'off';

export interface ThemeDescriptor {
    extensionId: string;
    id?: string;
    label?: string;
}

interface ThemeContribution {
    id?: unknown;
    label?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从扩展 packageJSON 的未知结构中提取主题贡献，避免依赖 any。 */
export function extractThemeDescriptors(extensionId: string, packageJson: unknown): ThemeDescriptor[] {
    if (!isRecord(packageJson)) {
        return [];
    }
    const contributes = packageJson.contributes;
    if (!isRecord(contributes) || !Array.isArray(contributes.themes)) {
        return [];
    }
    return contributes.themes.flatMap(theme => {
        if (!isRecord(theme)) {
            return [];
        }
        const contribution = theme as ThemeContribution;
        const id = typeof contribution.id === 'string' ? contribution.id : undefined;
        const label = typeof contribution.label === 'string' ? contribution.label : undefined;
        return id || label ? [{ extensionId, id, label }] : [];
    });
}

export interface ThemeCompatibilityInput {
    colorTheme: string;
    descriptors: readonly ThemeDescriptor[];
    mode: ThemeCompatibilityMode;
}

export interface ThemeCompatibilityDecision {
    enabled: boolean;
    reason: 'forced' | 'detected' | 'not-detected' | 'disabled';
    theme?: string;
}

/** 只覆盖 C/C++ Theme 会重新写入的现代 UI shell 层。 */
export function getThemeCompatibilityCss(): string {
    return [
        '.monaco-workbench { --modern-ui-shell-background: transparent !important; }',
        '.monaco-workbench > .monaco-grid-view { background: transparent !important; }',
    ].join(' ');
}

export function isThemeCompatibilityMode(value: unknown): value is ThemeCompatibilityMode {
    return value === 'auto' || value === 'on' || value === 'off';
}

export function shouldApplyThemeCompatibility(input: ThemeCompatibilityInput): ThemeCompatibilityDecision {
    if (input.mode === 'on') {
        return { enabled: true, reason: 'forced', theme: input.colorTheme };
    }
    if (input.mode === 'off') {
        return { enabled: false, reason: 'disabled', theme: input.colorTheme };
    }

    const detected = input.descriptors.some(descriptor => {
        if (descriptor.extensionId === 'ms-vscode.cpptools-themes') {
            return descriptor.id === input.colorTheme || descriptor.label === input.colorTheme;
        }
        return false;
    });
    return detected
        ? { enabled: true, reason: 'detected', theme: input.colorTheme }
        : { enabled: false, reason: 'not-detected', theme: input.colorTheme };
}
