export interface MediaStartupAttempt {
    readonly generation: number;
    readonly attempt: number;
}

export interface MediaStartupDependencies {
    attachSource(token: MediaStartupAttempt): void | PromiseLike<void>;
    schedule(delayMs: number, callback: () => void): () => void;
    report(event: string, token: MediaStartupAttempt, detail?: string): void;
}

export interface MediaStartupPolicy {
    maxAttempts: number;
    retryDelayMs: number;
}

export interface MediaStartupController {
    start(): void;
    restart(): void;
    failed(token: MediaStartupAttempt, reason: string): void;
    ready(token: MediaStartupAttempt): void;
    dispose(): void;
}

type MediaStartupPhase = 'idle' | 'attaching' | 'retry-wait' | 'ready' | 'exhausted' | 'disposed';

/**
 * 管理本地媒体源的启动代次与有界重试。
 * 调用方只在 `/ping` 已确认服务就绪后 start，并用 token 隔离迟到的 DOM/Promise 事件。
 */
export function createMediaStartupController(
    dependencies: MediaStartupDependencies,
    policy: MediaStartupPolicy
): MediaStartupController {
    const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
    let phase: MediaStartupPhase = 'idle';
    let generation = 0;
    let attempt = 0;
    let activeToken: MediaStartupAttempt | undefined;
    let cancelRetry: (() => void) | undefined;

    const isActive = (token: MediaStartupAttempt) => activeToken !== undefined
        && token.generation === activeToken.generation
        && token.attempt === activeToken.attempt;

    const cancelPendingRetry = () => {
        cancelRetry?.();
        cancelRetry = undefined;
    };

    const failActive = (token: MediaStartupAttempt, reason: string) => {
        if (!isActive(token) || phase !== 'attaching') {
            return;
        }
        if (token.attempt >= policy.maxAttempts) {
            phase = 'exhausted';
            dependencies.report('retry-exhausted', token, reason);
            return;
        }

        phase = 'retry-wait';
        dependencies.report('retry-scheduled', token, reason);
        cancelRetry = dependencies.schedule(policy.retryDelayMs, () => {
            cancelRetry = undefined;
            if (!isActive(token) || phase !== 'retry-wait') {
                return;
            }
            attachNextSource();
        });
    };

    const attachNextSource = () => {
        if (phase === 'disposed') {
            return;
        }
        attempt += 1;
        const token: MediaStartupAttempt = { generation, attempt };
        activeToken = token;
        phase = 'attaching';
        dependencies.report('attempt', token);

        try {
            Promise.resolve(dependencies.attachSource(token)).catch(error => {
                failActive(token, `attach-rejected: ${errorMessage(error)}`);
            });
        } catch (error: unknown) {
            failActive(token, `attach-rejected: ${errorMessage(error)}`);
        }
    };

    const beginGeneration = () => {
        cancelPendingRetry();
        generation += 1;
        attempt = 0;
        activeToken = undefined;
        phase = 'idle';
        attachNextSource();
    };

    return {
        start: () => {
            if (phase !== 'idle' || generation !== 0) {
                return;
            }
            beginGeneration();
        },
        restart: () => {
            if (phase === 'disposed') {
                return;
            }
            beginGeneration();
        },
        failed: failActive,
        ready: token => {
            if (!isActive(token) || phase !== 'attaching') {
                return;
            }
            cancelPendingRetry();
            phase = 'ready';
            dependencies.report('ready', token);
        },
        dispose: () => {
            if (phase === 'disposed') {
                return;
            }
            phase = 'disposed';
            generation += 1;
            activeToken = undefined;
            cancelPendingRetry();
        }
    };
}
