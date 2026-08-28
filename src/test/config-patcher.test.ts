import * as assert from 'assert';
import * as vscode from 'vscode';
import { normalizeTransparencyTargets } from '../core/config-patcher';

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
});
