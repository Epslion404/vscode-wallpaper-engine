import * as assert from 'assert';
import * as vscode from 'vscode';
import { normalizeTransparencyTargets, TRANSPARENT_COLOR_KEYS, TRANSPARENCY_COLOR_RULES } from '../core/config-patcher';

suite('Transparency patch target helpers', () => {
    test('defaults to global, workspace, and workspace-folder scopes', () => {
        assert.deepStrictEqual(normalizeTransparencyTargets(), [
            vscode.ConfigurationTarget.Global,
            vscode.ConfigurationTarget.Workspace,
            vscode.ConfigurationTarget.WorkspaceFolder
        ]);
    });

    test('deduplicates scopes while preserving caller order', () => {
        assert.deepStrictEqual(normalizeTransparencyTargets([
            vscode.ConfigurationTarget.Workspace,
            vscode.ConfigurationTarget.Global,
            vscode.ConfigurationTarget.Workspace
        ]), [
            vscode.ConfigurationTarget.Workspace,
            vscode.ConfigurationTarget.Global
        ]);
    });

    test('keeps explicit single-scope cleanup behavior', () => {
        assert.deepStrictEqual(normalizeTransparencyTargets(vscode.ConfigurationTarget.Global), [
            vscode.ConfigurationTarget.Global
        ]);
    });

    test('deduplicates workspace-folder scope', () => {
        assert.deepStrictEqual(normalizeTransparencyTargets([
            vscode.ConfigurationTarget.WorkspaceFolder,
            vscode.ConfigurationTarget.WorkspaceFolder,
            vscode.ConfigurationTarget.Global
        ]), [
            vscode.ConfigurationTarget.WorkspaceFolder,
            vscode.ConfigurationTarget.Global
        ]);
    });

    test('exposes unique descriptive rules for every supported transparency key', () => {
        assert.ok(TRANSPARENCY_COLOR_RULES.length > 100);
        assert.strictEqual(new Set(TRANSPARENT_COLOR_KEYS).size, TRANSPARENT_COLOR_KEYS.length);
        assert.ok(TRANSPARENT_COLOR_KEYS.includes('editorGutter.background'));
        assert.deepStrictEqual(
            TRANSPARENCY_COLOR_RULES.map(rule => rule.key),
            TRANSPARENT_COLOR_KEYS,
        );
        for (const rule of TRANSPARENCY_COLOR_RULES) {
            assert.ok(rule.labelZh.length > 0);
            assert.ok(rule.labelEn.length > 0);
        }
    });
});
