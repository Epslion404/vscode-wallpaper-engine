/**
 * 纯卸载编排器。
 *
 * 该模块不依赖 VS Code API，把清理步骤和宿主侧副作用通过依赖接口注入，
 * 便于在 Extension Host 中复用，也便于对失败、重试和幂等行为做单元测试。
 */

export enum UninstallStage {
    AcquireLock = 'acquireLock',
    Disable = 'disable',
    ClearPendingSetup = 'clearPendingSetup',
    RestoreWorkbench = 'restoreWorkbench',
    RemoveTransparency = 'removeTransparency',
    StopServer = 'stopServer',
    ClearPersistedState = 'clearPersistedState',
    SavePending = 'savePending',
    ReloadWorkbench = 'reloadWorkbench',
    ReleaseLock = 'releaseLock'
}

export interface UninstallStageResult {
    stage: UninstallStage;
    status: 'success' | 'failed';
    message?: string;
}

export interface PendingUninstall {
    operationId: string;
    createdAt: number;
    reloadRequired: boolean;
    stages: readonly UninstallStageResult[];
}

export function isPendingUninstall(value: unknown): value is PendingUninstall {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as { operationId?: unknown; createdAt?: unknown; reloadRequired?: unknown; stages?: unknown };
    return typeof candidate.operationId === 'string'
        && candidate.operationId.length > 0
        && typeof candidate.createdAt === 'number'
        && Number.isFinite(candidate.createdAt)
        && typeof candidate.reloadRequired === 'boolean'
        && Array.isArray(candidate.stages);
}

export interface UninstallStateSnapshot {
    /** 磁盘上的 Workbench 文件已恢复，且不再包含插件注入标记。 */
    workbenchRestored: boolean;
    /** 本地 HTTP/WebSocket 服务已停止且端口不可达。 */
    serverStopped: boolean;
    /** Global 与 Workspace 的插件托管透明化备份均已清空。 */
    transparencyBackupsEmpty: boolean;
    /** currentWallpaper*、wallpaperId 及 pending setup 状态均已清除。 */
    persistedStateCleared: boolean;
}

export interface UninstallVerification {
    ok: boolean;
    failures: readonly string[];
}

export interface UninstallDependencies {
    disable(): PromiseLike<void>;
    clearPendingSetup(): PromiseLike<void>;
    restoreWorkbench(): PromiseLike<void>;
    removeTransparency(): PromiseLike<void>;
    stopServer(): PromiseLike<void>;
    clearPersistedState(): PromiseLike<void>;
    savePendingUninstall(pending: PendingUninstall): PromiseLike<void>;
    reloadWorkbench(): PromiseLike<void>;
    report(stage: UninstallStage): void;
    createOperationId(): string;
    now(): number;
    /** 返回 false 表示已有设置/卸载操作持有生命周期锁。 */
    acquireLock?(): PromiseLike<boolean>;
    releaseLock?(): PromiseLike<void>;
}

export interface UninstallOptions {
    /** 是否需要在磁盘恢复后重载当前 Workbench；默认 true。 */
    reloadRequired?: boolean;
}

export interface UninstallResult {
    operationId: string;
    completed: boolean;
    reloadRequired: boolean;
    reloaded: boolean;
    pendingUninstall?: PendingUninstall;
    stageResults: readonly UninstallStageResult[];
    errors: readonly UninstallError[];
}

export class UninstallError extends Error {
    public constructor(
        public readonly stage: UninstallStage,
        message: string,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'UninstallError';
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function asUninstallError(stage: UninstallStage, error: unknown): UninstallError {
    if (error instanceof UninstallError) {
        return error;
    }
    return new UninstallError(stage, errorMessage(error), { cause: error });
}

/**
 * 验证激活阶段读取到的卸载快照。此函数不执行 IO，适合在重载后和测试中调用。
 */
export function verifyUninstallState(state: UninstallStateSnapshot): UninstallVerification {
    const failures: string[] = [];
    if (!state.workbenchRestored) {
        failures.push('Workbench 注入标记仍存在');
    }
    if (!state.serverStopped) {
        failures.push('壁纸服务仍在运行');
    }
    if (!state.transparencyBackupsEmpty) {
        failures.push('透明化托管备份仍存在');
    }
    if (!state.persistedStateCleared) {
        failures.push('壁纸持久化状态仍存在');
    }
    return { ok: failures.length === 0, failures };
}

/**
 * 逐步执行还原流程。单步失败不会阻止后续步骤，所有错误会在结果中聚合。
 * 该函数刻意不抛出清理阶段异常，调用方可据 `completed` 和 `errors` 展示重试入口。
 */
export async function runUninstall(
    dependencies: UninstallDependencies,
    options: UninstallOptions = {}
): Promise<UninstallResult> {
    const operationId = dependencies.createOperationId();
    const stageResults: UninstallStageResult[] = [];
    const errors: UninstallError[] = [];
    let lockAcquired = true;
    let reloadRequired = options.reloadRequired ?? true;
    let reloaded = false;
    let pendingUninstall: PendingUninstall | undefined;

    const report = (stage: UninstallStage): void => {
        try {
            dependencies.report(stage);
        } catch (error) {
            // 日志/进度回调不应破坏清理事务；把回调异常作为该阶段失败记录。
            const reportError = asUninstallError(stage, error);
            errors.push(reportError);
        }
    };

    const runStage = async (
        stage: UninstallStage,
        action: () => PromiseLike<void>
    ): Promise<boolean> => {
        report(stage);
        try {
            await action();
            stageResults.push({ stage, status: 'success' });
            return true;
        } catch (error) {
            const uninstallError = asUninstallError(stage, error);
            errors.push(uninstallError);
            stageResults.push({ stage, status: 'failed', message: uninstallError.message });
            return false;
        }
    };

    report(UninstallStage.AcquireLock);
    try {
        lockAcquired = dependencies.acquireLock ? await dependencies.acquireLock() : true;
    } catch (error) {
        lockAcquired = false;
        const lockError = asUninstallError(UninstallStage.AcquireLock, error);
        errors.push(lockError);
        stageResults.push({ stage: UninstallStage.AcquireLock, status: 'failed', message: lockError.message });
    }

    if (!lockAcquired) {
        if (errors.length === 0) {
            const busyError = new UninstallError(UninstallStage.AcquireLock, '已有壁纸操作正在进行');
            errors.push(busyError);
            stageResults.push({ stage: UninstallStage.AcquireLock, status: 'failed', message: busyError.message });
        } else if (!stageResults.some(result => result.stage === UninstallStage.AcquireLock)) {
            stageResults.push({ stage: UninstallStage.AcquireLock, status: 'failed', message: errors[0].message });
        }
        return {
            operationId,
            completed: false,
            reloadRequired: false,
            reloaded: false,
            stageResults,
            errors
        };
    }

    try {
        // 先设置禁用闸门，阻止配置/主题监听在清理期间重新注入。
        await runStage(UninstallStage.Disable, () => dependencies.disable());
        await runStage(UninstallStage.ClearPendingSetup, () => dependencies.clearPendingSetup());
        const restored = await runStage(UninstallStage.RestoreWorkbench, () => dependencies.restoreWorkbench());
        await runStage(UninstallStage.RemoveTransparency, () => dependencies.removeTransparency());
        await runStage(UninstallStage.StopServer, () => dependencies.stopServer());
        await runStage(UninstallStage.ClearPersistedState, () => dependencies.clearPersistedState());

        // Workbench 文件恢复成功后，当前窗口中的旧脚本仍可能存活，需要跨重载完成清理。
        reloadRequired = reloadRequired && restored;
        if (reloadRequired) {
            pendingUninstall = {
                operationId,
                createdAt: dependencies.now(),
                reloadRequired: true,
                stages: [...stageResults]
            };
            const pendingSaved = await runStage(
                UninstallStage.SavePending,
                () => dependencies.savePendingUninstall(pendingUninstall!)
            );
            if (pendingSaved) {
                reloaded = await runStage(UninstallStage.ReloadWorkbench, () => dependencies.reloadWorkbench());
            } else {
                // 未能持久化 pending 记录时禁止重载，避免重载后无法完成最终验证。
                reloadRequired = false;
                pendingUninstall = undefined;
            }
        }
    } finally {
        if (dependencies.releaseLock) {
            await runStage(UninstallStage.ReleaseLock, () => dependencies.releaseLock!());
        }
    }

    return {
        operationId,
        completed: errors.length === 0,
        reloadRequired,
        reloaded,
        pendingUninstall,
        stageResults,
        errors
    };
}
