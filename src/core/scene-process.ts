import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

const PROCESS_OUTPUT_LIMIT = 64 * 1024;

export interface SceneProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export class SceneRecordingError extends Error {
    public constructor(
        public readonly code: 'dependency' | 'launch' | 'window' | 'capture' | 'blackFrames' | 'cache' | 'cancelled',
        message: string,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = 'SceneRecordingError';
    }
}

function appendLimited(current: string, chunk: Buffer): string {
    const next = current + chunk.toString('utf8');
    return next.length > PROCESS_OUTPUT_LIMIT ? next.slice(-PROCESS_OUTPUT_LIMIT) : next;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.killed) {
        return;
    }
    child.stdin.once('error', () => {
        if (child.exitCode === null) {
            child.kill();
        }
    });
    try {
        child.stdin.write('q\n');
    } catch {
        child.kill();
        return;
    }
    await new Promise<void>(resolve => {
        const forceTimer = setTimeout(() => {
            if (child.exitCode === null) {
                child.kill();
            }
            resolve();
        }, 1500);
        child.once('close', () => {
            clearTimeout(forceTimer);
            resolve();
        });
    });
}

export async function runSceneProcess(
    executable: string,
    args: readonly string[],
    options: { signal?: AbortSignal; timeoutMs: number }
): Promise<SceneProcessResult> {
    if (options.signal?.aborted) {
        throw new SceneRecordingError('cancelled', 'Scene 录制已取消');
    }

    return new Promise<SceneProcessResult>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let aborted = false;
        const child = spawn(executable, args, { windowsHide: true, stdio: 'pipe' });
        const finish = (action: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', onAbort);
            action();
        };
        const onAbort = (): void => {
            aborted = true;
            void stopChild(child);
        };
        const timeout = setTimeout(() => {
            timedOut = true;
            void stopChild(child);
        }, options.timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
            stdout = appendLimited(stdout, chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr = appendLimited(stderr, chunk);
        });
        child.once('error', error => finish(() => reject(error)));
        child.once('close', code => finish(() => {
            if (aborted) {
                reject(new SceneRecordingError('cancelled', 'Scene 录制已取消'));
                return;
            }
            if (timedOut) {
                reject(new Error(`进程运行超时（${options.timeoutMs}ms）`));
                return;
            }
            resolve({ exitCode: code ?? -1, stdout, stderr });
        }));
        options.signal?.addEventListener('abort', onAbort, { once: true });
    });
}
