import * as assert from 'assert';
import {
    extractThemeDescriptors,
    getThemeCompatibilityCss,
    isThemeCompatibilityMode,
    shouldApplyThemeCompatibility,
    ThemeDescriptor,
} from '../core/theme-compatibility';

suite('Theme compatibility', () => {
    const cppThemes: ThemeDescriptor[] = [
        { extensionId: 'ms-vscode.cpptools-themes', id: 'Visual Studio Dark - C++', label: 'Dark (Visual Studio - C/C++)' },
        { extensionId: 'ms-vscode.cpptools-themes', id: 'Visual Studio Light - C++', label: 'Light (Visual Studio - C/C++)' },
    ];

    test('detects C/C++ Theme contributions by extension and label', () => {
        assert.strictEqual(
            shouldApplyThemeCompatibility({ colorTheme: 'Dark (Visual Studio - C/C++)', descriptors: cppThemes, mode: 'auto' }).enabled,
            true,
        );
        assert.strictEqual(
            shouldApplyThemeCompatibility({ colorTheme: 'Visual Studio Light - C++', descriptors: cppThemes, mode: 'auto' }).enabled,
            true,
        );
    });

    test('does not classify unrelated themes as C/C++ Theme', () => {
        const descriptors: ThemeDescriptor[] = [
            { extensionId: 'publisher.other-theme', id: 'cpp-night', label: 'C++ Night' },
        ];
        assert.strictEqual(
            shouldApplyThemeCompatibility({ colorTheme: 'C++ Night', descriptors, mode: 'auto' }).enabled,
            false,
        );
    });

    test('supports explicit compatibility overrides', () => {
        assert.strictEqual(
            shouldApplyThemeCompatibility({ colorTheme: 'Default Dark+', descriptors: [], mode: 'on' }).enabled,
            true,
        );
        assert.strictEqual(
            shouldApplyThemeCompatibility({ colorTheme: 'Dark (Visual Studio - C/C++)', descriptors: cppThemes, mode: 'off' }).enabled,
            false,
        );
    });

    test('validates compatibility mode values', () => {
        assert.strictEqual(isThemeCompatibilityMode('auto'), true);
        assert.strictEqual(isThemeCompatibilityMode('on'), true);
        assert.strictEqual(isThemeCompatibilityMode('off'), true);
        assert.strictEqual(isThemeCompatibilityMode('always'), false);
    });

    test('extracts theme descriptors from untrusted package metadata', () => {
        assert.deepStrictEqual(
            extractThemeDescriptors('ms-vscode.cpptools-themes', {
                contributes: { themes: [{ id: 'Visual Studio Dark - C++', label: 'Dark (Visual Studio - C/C++)' }, null] },
            }),
            [{ extensionId: 'ms-vscode.cpptools-themes', id: 'Visual Studio Dark - C++', label: 'Dark (Visual Studio - C/C++)' }],
        );
        assert.deepStrictEqual(extractThemeDescriptors('other', { contributes: { themes: 'invalid' } }), []);
    });

    test('provides a focused CSS override for the modern UI shell', () => {
        const css = getThemeCompatibilityCss();
        assert.match(css, /--modern-ui-shell-background:\s*transparent\s*!important/);
        assert.match(css, /\.monaco-workbench\s*>\s*\.monaco-grid-view/);
    });
});
