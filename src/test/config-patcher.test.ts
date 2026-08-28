import * as assert from 'assert';
import * as vscode from 'vscode';
import { normalizeTransparencyTargets } from '../core/config-patcher';

suite('Transparency patch target helpers', () => {
    test('defaults to both global and workspace scopes', () => {
        assert.deepStrictEqual(normalizeTransparencyTargets(), [
            vscode.ConfigurationTarget.Global,
            vscode.ConfigurationTarget.Workspace
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
});
