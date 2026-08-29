import * as assert from 'assert';
import { applyManagedColors, restoreManagedColors } from '../core/transparency-state';

suite('Transparency State Test Suite', () => {
    test('restores original colors without overwriting later user changes', () => {
        const first = applyManagedColors(
            {
                'editor.background': '#112233',
                'sideBar.background': '#445566'
            },
            {
                'editor.background': '#00000000',
                'panel.background': '#00000000'
            },
            {}
        );

        assert.deepStrictEqual(first.customizations, {
            'editor.background': '#00000000',
            'sideBar.background': '#445566',
            'panel.background': '#00000000'
        });

        const restored = restoreManagedColors({
            ...first.customizations,
            'panel.background': '#ABCDEF'
        }, first.backups);

        assert.deepStrictEqual(restored, {
            'editor.background': '#112233',
            'sideBar.background': '#445566',
            'panel.background': '#ABCDEF'
        });
    });

    test('backs up and restores the modern UI surface color', () => {
        const applied = applyManagedColors(
            { 'surface.background': '#202124' },
            { 'surface.background': '#00000000' },
            {},
        );

        assert.deepStrictEqual(applied.customizations, {
            'surface.background': '#00000000',
        });
        assert.deepStrictEqual(restoreManagedColors(applied.customizations, applied.backups), {
            'surface.background': '#202124',
        });
    });
});
