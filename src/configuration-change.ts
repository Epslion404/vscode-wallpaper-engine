const TRANSPARENCY_KEYS = new Set([
    'transparencyEnabled',
    'transparencyRules',
    'transparencyBaseColor'
]);

const WALLPAPER_KEYS = new Set([
    'wallpaperId',
    'workshopPath',
    'backgroundOpacity',
    'serverPort',
    'resizeDelay',
    'startupCheckInterval',
    'customCss'
]);

export function classifyConfigurationChange(keys: string[]): { wallpaper: boolean; transparency: boolean } {
    return {
        wallpaper: keys.some(key => WALLPAPER_KEYS.has(key)),
        transparency: keys.some(key => TRANSPARENCY_KEYS.has(key))
    };
}
