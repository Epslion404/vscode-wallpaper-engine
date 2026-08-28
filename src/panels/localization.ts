export type UiLanguage = 'auto' | 'zh-CN' | 'en-US';
export type ResolvedUiLanguage = Exclude<UiLanguage, 'auto'>;

export function isUiLanguage(value: unknown): value is UiLanguage {
    return value === 'auto' || value === 'zh-CN' || value === 'en-US';
}

export function resolveUiLanguage(setting: UiLanguage, vscodeLocale: string): ResolvedUiLanguage {
    if (setting !== 'auto') {
        return setting;
    }
    return vscodeLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}
