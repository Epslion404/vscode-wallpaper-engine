import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseSettingsPanelMessage } from '../panels/setting-panel';

suite('Settings panel message protocol', () => {
    test('parses commands without payload', () => {
        const commands = [
            'ready',
            'refresh',
            'switch',
            'openBrowser',
            'openFolder',
            'stopServer',
            'editCustomCss',
        ];

        for (const command of commands) {
            assert.deepStrictEqual(parseSettingsPanelMessage({ command }), { command });
        }
    });

    test('parses typed settings payloads', () => {
        assert.deepStrictEqual(
            parseSettingsPanelMessage({ command: 'updateCss', customCss: 'body { opacity: 0.5; }' }),
            { command: 'updateCss', customCss: 'body { opacity: 0.5; }' },
        );
        assert.deepStrictEqual(
            parseSettingsPanelMessage({ command: 'toggleTransparency', enabled: false }),
            { command: 'toggleTransparency', enabled: false },
        );
        assert.deepStrictEqual(
            parseSettingsPanelMessage({ command: 'updateTransparencyBaseColor', color: '#1e1e1e' }),
            { command: 'updateTransparencyBaseColor', color: '#1e1e1e' },
        );
        assert.deepStrictEqual(
            parseSettingsPanelMessage({ command: 'setLanguage', language: 'en-US' }),
            { command: 'setLanguage', language: 'en-US' },
        );
        assert.deepStrictEqual(
            parseSettingsPanelMessage({
                command: 'updateTransparencyRules',
                rules: { 'editor.background': 0, 'sideBar.background': 0.25 },
            }),
            {
                command: 'updateTransparencyRules',
                rules: { 'editor.background': 0, 'sideBar.background': 0.25 },
            },
        );
    });

    test('preserves JSON-compatible property values', () => {
        assert.deepStrictEqual(
            parseSettingsPanelMessage({ command: 'updateProp', key: 'speed', value: 1.5 }),
            { command: 'updateProp', key: 'speed', value: 1.5 },
        );
        assert.deepStrictEqual(
            parseSettingsPanelMessage({ command: 'updateGeneral', key: 'muted', value: true }),
            { command: 'updateGeneral', key: 'muted', value: true },
        );
    });

    test('rejects unknown commands and malformed payloads', () => {
        const malformedMessages: unknown[] = [
            null,
            'refresh',
            {},
            { command: 'unknown' },
            { command: 'updateCss', customCss: 1 },
            { command: 'toggleTransparency', enabled: 'true' },
            { command: 'updateTransparencyRules', rules: [] },
            { command: 'updateTransparencyRules', rules: { editor: Number.NaN } },
            { command: 'updateTransparencyRules', rules: { editor: 2 } },
            { command: 'updateProp', key: '', value: 1 },
            { command: 'updateProp', key: '__proto__', value: 1 },
            { command: 'updateGeneral', key: 'constructor', value: true },
            { command: 'setLanguage', language: 'fr-FR' },
        ];

        for (const message of malformedMessages) {
            assert.strictEqual(parseSettingsPanelMessage(message), undefined);
        }
    });

    test('publishes language and theme compatibility state to the webview', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'panels', 'setting-panel.ts'), 'utf8');
        assert.match(source, /type:\s*'language'/);
        assert.match(source, /type:\s*'compatibilityStatus'/);
        assert.match(source, /update\('uiLanguage'/);
    });

    test('pins one configuration resource for the panel lifetime', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'panels', 'setting-panel.ts'), 'utf8');
        assert.match(source, /private readonly resource: vscode\.Uri \| undefined/);
        assert.match(source, /this\.resource = getSettingsResource\(\)/);
        assert.match(source, /getPreferredTransparencyTarget\(this\.resource\)/);
        assert.match(source, /getSettingsConfiguration\(this\.resource\)\.get<Record<string, number>>\('transparencyRules'\)/);
        assert.match(source, /transparencyDescriptions/);
        const webview = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'settings.js'), 'utf8');
        assert.match(webview, /#propsPanel \.control-item, #transparencyPanel \.control-item/);
        assert.match(webview, /dataset\.searchText/);
    });

    test('publishes the modern UI surface rule for localized display and key search', () => {
        const patcher = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'config-patcher.ts'), 'utf8');
        const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'panels', 'setting-panel.ts'), 'utf8');
        const webview = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'settings.js'), 'utf8');

        assert.match(patcher, /key: 'surface\.background'/);
        assert.match(patcher, /labelZh: '现代界面基础表面背景'/);
        assert.match(patcher, /labelEn: 'Modern UI surface background'/);
        assert.match(panel, /TRANSPARENCY_COLOR_RULES\.map\(rule => \[rule\.key, \{ zhCN: rule\.labelZh, enUS: rule\.labelEn \}\]\)/);
        assert.match(webview, /description\?\.zhCN/);
        assert.match(webview, /description\?\.enUS/);
        assert.match(webview, /description\?\.zhCN \|\| "",\s*description\?\.enUS \|\| "",\s*key,/);
    });
});
