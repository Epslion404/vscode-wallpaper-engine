import * as assert from 'assert';
import {
    PendingUninstall,
    runUninstall,
    UninstallDependencies,
    UninstallStage,
    UninstallStateSnapshot,
    verifyUninstallState
} from '../core/uninstall';

function createDependencies(calls: string[], overrides: Partial<UninstallDependencies> = {}): UninstallDependencies {
    const action = (name: string): (() => Promise<void>) => async () => { calls.push(name); };
    return {
        disable: action('disable'),
        clearPendingSetup: action('clearPendingSetup'),
        restoreWorkbench: action('restoreWorkbench'),
        removeTransparency: action('removeTransparency'),
        stopServer: action('stopServer'),
        clearPersistedState: action('clearPersistedState'),
        savePendingUninstall: async (pending: PendingUninstall) => {
            calls.push(`savePending:${pending.operationId}`);
        },
        reloadWorkbench: action('reloadWorkbench'),
        report: stage => calls.push(`report:${stage}`),
        createOperationId: () => 'uninstall-1',
        now: () => 1234,
        acquireLock: async () => {
            calls.push('acquireLock');
            return true;
        },
        releaseLock: async () => { calls.push('releaseLock'); },
        ...overrides
    };
}

suite('Uninstall Orchestrator Test Suite', () => {
    test('runs cleanup in order, persists pending state, and requests reload', async () => {
        const calls: string[] = [];
        const result = await runUninstall(createDependencies(calls));

        assert.strictEqual(result.operationId, 'uninstall-1');
        assert.strictEqual(result.completed, true);
        assert.strictEqual(result.reloadRequired, true);
        assert.strictEqual(result.reloaded, true);
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.pendingUninstall?.createdAt, 1234);
        assert.strictEqual(result.pendingUninstall?.reloadRequired, true);
        assert.deepStrictEqual(
            calls.filter(call => !call.startsWith('report:')),
            [
                'acquireLock',
                'disable',
                'clearPendingSetup',
                'restoreWorkbench',
                'removeTransparency',
                'stopServer',
                'clearPersistedState',
                'savePending:uninstall-1',
                'reloadWorkbench',
                'releaseLock'
            ]
        );
    });

    test('continues after a stage failure and aggregates errors', async () => {
        const calls: string[] = [];
        const result = await runUninstall(createDependencies(calls, {
            removeTransparency: async () => {
                calls.push('removeTransparency');
                throw new Error('透明化配置被锁定');
            },
            stopServer: async () => {
                calls.push('stopServer');
                throw new Error('服务停止失败');
            }
        }));

        assert.strictEqual(result.completed, false);
        assert.strictEqual(result.errors.length, 2);
        assert.deepStrictEqual(result.errors.map(error => error.stage), [
            UninstallStage.RemoveTransparency,
            UninstallStage.StopServer
        ]);
        assert.strictEqual(result.reloadRequired, true);
        assert.strictEqual(result.reloaded, true);
        assert.ok(calls.includes('clearPersistedState'));
        assert.ok(calls.includes('reloadWorkbench'));
        assert.ok(calls.includes('releaseLock'));
    });

    test('does not reload when Workbench restore fails, but still finishes other cleanup', async () => {
        const calls: string[] = [];
        const result = await runUninstall(createDependencies(calls, {
            restoreWorkbench: async () => {
                calls.push('restoreWorkbench');
                throw new Error('无法恢复 Workbench');
            }
        }));

        assert.strictEqual(result.completed, false);
        assert.strictEqual(result.reloadRequired, false);
        assert.strictEqual(result.reloaded, false);
        assert.strictEqual(result.pendingUninstall, undefined);
        assert.ok(calls.includes('removeTransparency'));
        assert.ok(calls.includes('stopServer'));
        assert.ok(calls.includes('clearPersistedState'));
        assert.ok(!calls.includes('reloadWorkbench'));
    });

    test('returns a busy result without running cleanup when the lifecycle lock is held', async () => {
        const calls: string[] = [];
        const result = await runUninstall(createDependencies(calls, {
            acquireLock: async () => {
                calls.push('acquireLock');
                return false;
            }
        }));

        assert.strictEqual(result.completed, false);
        assert.strictEqual(result.reloadRequired, false);
        assert.strictEqual(result.errors.length, 1);
        assert.strictEqual(result.errors[0].stage, UninstallStage.AcquireLock);
        assert.match(result.errors[0].message, /已有壁纸操作正在进行/);
        assert.deepStrictEqual(calls.filter(call => !call.startsWith('report:')), ['acquireLock']);
    });

    test('does not persist pending state when reload is disabled', async () => {
        const calls: string[] = [];
        const result = await runUninstall(createDependencies(calls), { reloadRequired: false });

        assert.strictEqual(result.completed, true);
        assert.strictEqual(result.reloadRequired, false);
        assert.strictEqual(result.reloaded, false);
        assert.strictEqual(result.pendingUninstall, undefined);
        assert.ok(!calls.includes('savePending:uninstall-1'));
        assert.ok(!calls.includes('reloadWorkbench'));
    });

    test('keeps cleanup result when saving pending state fails and avoids reload', async () => {
        const calls: string[] = [];
        const result = await runUninstall(createDependencies(calls, {
            savePendingUninstall: async () => {
                calls.push('savePending');
                throw new Error('无法保存待处理记录');
            }
        }));

        assert.strictEqual(result.completed, false);
        assert.strictEqual(result.reloadRequired, false);
        assert.strictEqual(result.reloaded, false);
        assert.strictEqual(result.pendingUninstall, undefined);
        assert.ok(!calls.includes('reloadWorkbench'));
        assert.strictEqual(result.errors[0].stage, UninstallStage.SavePending);
    });

    test('aggregates release-lock failure after cleanup', async () => {
        const calls: string[] = [];
        const result = await runUninstall(createDependencies(calls, {
            releaseLock: async () => {
                calls.push('releaseLock');
                throw new Error('锁释放失败');
            }
        }), { reloadRequired: false });

        assert.strictEqual(result.completed, false);
        assert.strictEqual(result.errors.length, 1);
        assert.strictEqual(result.errors[0].stage, UninstallStage.ReleaseLock);
        assert.deepStrictEqual(calls.filter(call => !call.startsWith('report:')).slice(-1), ['releaseLock']);
    });

    test('verifies a clean snapshot and reports every failed invariant', () => {
        const clean: UninstallStateSnapshot = {
            workbenchRestored: true,
            serverStopped: true,
            transparencyBackupsEmpty: true,
            persistedStateCleared: true
        };
        assert.deepStrictEqual(verifyUninstallState(clean), { ok: true, failures: [] });

        const dirty = verifyUninstallState({
            workbenchRestored: false,
            serverStopped: false,
            transparencyBackupsEmpty: false,
            persistedStateCleared: false
        });
        assert.strictEqual(dirty.ok, false);
        assert.deepStrictEqual(dirty.failures, [
            'Workbench 注入标记仍存在',
            '壁纸服务仍在运行',
            '透明化托管备份仍存在',
            '壁纸持久化状态仍存在'
        ]);
    });
});
