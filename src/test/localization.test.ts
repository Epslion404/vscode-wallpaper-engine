import * as assert from 'assert';
import {
    isUiLanguage,
    resolveUiLanguage,
    UiLanguage,
} from '../panels/localization';

suite('Settings localization', () => {
    test('validates supported language values', () => {
        assert.strictEqual(isUiLanguage('auto'), true);
        assert.strictEqual(isUiLanguage('zh-CN'), true);
        assert.strictEqual(isUiLanguage('en-US'), true);
        assert.strictEqual(isUiLanguage('fr-FR'), false);
    });

    test('resolves auto language from VS Code locale', () => {
        assert.strictEqual(resolveUiLanguage('auto', 'zh-cn'), 'zh-CN');
        assert.strictEqual(resolveUiLanguage('auto', 'en-US'), 'en-US');
        assert.strictEqual(resolveUiLanguage('auto', 'ja'), 'en-US');
    });

    test('preserves explicit language selection', () => {
        const values: UiLanguage[] = ['zh-CN', 'en-US'];
        for (const value of values) {
            assert.strictEqual(resolveUiLanguage(value, 'en-US'), value);
        }
    });
});
