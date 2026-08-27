import * as assert from 'assert';
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
        ];

        for (const message of malformedMessages) {
            assert.strictEqual(parseSettingsPanelMessage(message), undefined);
        }
    });
});
