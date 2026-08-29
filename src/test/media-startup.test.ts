import * as assert from 'assert';
import {
    createMediaStartupController,
    MediaStartupAttempt,
} from '../core/media-startup';

interface ScheduledTask {
    readonly delayMs: number;
    readonly callback: () => void;
    canceled: boolean;
}

function token(generation: number, attempt: number): MediaStartupAttempt {
    return { generation, attempt };
}

suite('Media Startup Controller', () => {
    test('does not attach the media source until startup is explicitly requested', () => {
        const attempts: MediaStartupAttempt[] = [];
        const controller = createMediaStartupController({
            attachSource: current => { attempts.push(current); },
            schedule: () => () => undefined,
            report: () => undefined
        }, { maxAttempts: 3, retryDelayMs: 250 });

        assert.deepStrictEqual(attempts, []);
        controller.start();
        assert.deepStrictEqual(attempts, [token(1, 1)]);
    });

    test('start is idempotent while a startup generation is active', () => {
        const attempts: MediaStartupAttempt[] = [];
        const controller = createMediaStartupController({
            attachSource: current => { attempts.push(current); },
            schedule: () => () => undefined,
            report: () => undefined
        }, { maxAttempts: 3, retryDelayMs: 250 });

        controller.start();
        controller.start();
        assert.deepStrictEqual(attempts, [token(1, 1)]);
    });

    test('restart creates a new generation and invalidates the previous attempt', () => {
        const attempts: MediaStartupAttempt[] = [];
        const controller = createMediaStartupController({
            attachSource: current => { attempts.push(current); },
            schedule: () => () => undefined,
            report: () => undefined
        }, { maxAttempts: 3, retryDelayMs: 250 });

        controller.start();
        controller.restart();
        controller.failed(token(1, 1), 'late-load-error');

        assert.deepStrictEqual(attempts, [token(1, 1), token(2, 1)]);
    });

    test('retries a failed active attempt after the configured delay', () => {
        const attempts: MediaStartupAttempt[] = [];
        const scheduled: ScheduledTask[] = [];
        const controller = createMediaStartupController({
            attachSource: current => { attempts.push(current); },
            schedule: (delayMs, callback) => {
                const task = { delayMs, callback, canceled: false };
                scheduled.push(task);
                return () => { task.canceled = true; };
            },
            report: () => undefined
        }, { maxAttempts: 3, retryDelayMs: 250 });

        controller.start();
        controller.failed(token(1, 1), 'load-error');
        controller.failed(token(1, 1), 'duplicate-load-error');

        assert.strictEqual(scheduled.length, 1);
        assert.strictEqual(scheduled[0].delayMs, 250);
        scheduled[0].callback();
        assert.deepStrictEqual(attempts, [token(1, 1), token(1, 2)]);
    });

    test('stops after the configured attempt limit and reports exhaustion once', () => {
        const attempts: MediaStartupAttempt[] = [];
        const scheduled: ScheduledTask[] = [];
        const reports: string[] = [];
        const controller = createMediaStartupController({
            attachSource: current => { attempts.push(current); },
            schedule: (delayMs, callback) => {
                const task = { delayMs, callback, canceled: false };
                scheduled.push(task);
                return () => { task.canceled = true; };
            },
            report: event => { reports.push(event); }
        }, { maxAttempts: 3, retryDelayMs: 250 });

        controller.start();
        controller.failed(token(1, 1), 'load-error');
        scheduled[0].callback();
        controller.failed(token(1, 2), 'load-error');
        scheduled[1].callback();
        controller.failed(token(1, 3), 'load-error');
        controller.failed(token(1, 3), 'duplicate-load-error');

        assert.deepStrictEqual(attempts, [token(1, 1), token(1, 2), token(1, 3)]);
        assert.strictEqual(scheduled.length, 2);
        assert.strictEqual(reports.filter(event => event === 'retry-exhausted').length, 1);
    });

    test('late ready after a failed attempt does not cancel its retry', () => {
        const attempts: MediaStartupAttempt[] = [];
        const scheduled: ScheduledTask[] = [];
        const controller = createMediaStartupController({
            attachSource: current => { attempts.push(current); },
            schedule: (delayMs, callback) => {
                const task = { delayMs, callback, canceled: false };
                scheduled.push(task);
                return () => { task.canceled = true; };
            },
            report: () => undefined
        }, { maxAttempts: 3, retryDelayMs: 250 });

        controller.start();
        controller.failed(token(1, 1), 'load-error');
        controller.ready(token(1, 1));
        scheduled[0].callback();

        assert.strictEqual(scheduled[0].canceled, false);
        assert.deepStrictEqual(attempts, [token(1, 1), token(1, 2)]);
    });

    test('ready while attaching prevents later failure from scheduling a retry', () => {
        const scheduled: ScheduledTask[] = [];
        const reports: string[] = [];
        const controller = createMediaStartupController({
            attachSource: () => undefined,
            schedule: (delayMs, callback) => {
                const task = { delayMs, callback, canceled: false };
                scheduled.push(task);
                return () => { task.canceled = true; };
            },
            report: event => { reports.push(event); }
        }, { maxAttempts: 3, retryDelayMs: 250 });

        controller.start();
        controller.ready(token(1, 1));
        controller.failed(token(1, 1), 'late-load-error');

        assert.strictEqual(scheduled.length, 0);
        assert.strictEqual(reports.filter(event => event === 'ready').length, 1);
    });

    test('restart cancels an old retry and ignores its queued callback', () => {
        const attempts: MediaStartupAttempt[] = [];
        const scheduled: ScheduledTask[] = [];
        const controller = createMediaStartupController({
            attachSource: current => { attempts.push(current); },
            schedule: (delayMs, callback) => {
                const task = { delayMs, callback, canceled: false };
                scheduled.push(task);
                return () => { task.canceled = true; };
            },
            report: () => undefined
        }, { maxAttempts: 3, retryDelayMs: 250 });

        controller.start();
        controller.failed(token(1, 1), 'load-error');
        controller.restart();
        scheduled[0].callback();

        assert.strictEqual(scheduled[0].canceled, true);
        assert.deepStrictEqual(attempts, [token(1, 1), token(2, 1)]);
    });

    test('dispose cancels pending work and makes late callbacks inert', () => {
        const attempts: MediaStartupAttempt[] = [];
        const scheduled: ScheduledTask[] = [];
        const controller = createMediaStartupController({
            attachSource: current => { attempts.push(current); },
            schedule: (delayMs, callback) => {
                const task = { delayMs, callback, canceled: false };
                scheduled.push(task);
                return () => { task.canceled = true; };
            },
            report: () => undefined
        }, { maxAttempts: 3, retryDelayMs: 250 });

        controller.start();
        controller.failed(token(1, 1), 'load-error');
        controller.dispose();
        scheduled[0].callback();
        controller.failed(token(1, 1), 'late-load-error');
        controller.ready(token(1, 1));
        controller.start();
        controller.restart();

        assert.strictEqual(scheduled[0].canceled, true);
        assert.deepStrictEqual(attempts, [token(1, 1)]);
    });

    test('async attach rejection follows the same bounded retry path', async () => {
        const scheduled: ScheduledTask[] = [];
        const reports: string[] = [];
        const controller = createMediaStartupController({
            attachSource: () => Promise.reject(new Error('source unavailable')),
            schedule: (delayMs, callback) => {
                const task = { delayMs, callback, canceled: false };
                scheduled.push(task);
                return () => { task.canceled = true; };
            },
            report: event => { reports.push(event); }
        }, { maxAttempts: 3, retryDelayMs: 250 });

        controller.start();
        await Promise.resolve();
        await Promise.resolve();

        assert.strictEqual(scheduled.length, 1);
        assert.ok(reports.includes('retry-scheduled'));
    });

    test('late async rejection from an old generation does not affect the current generation', async () => {
        let rejectFirst: ((reason: Error) => void) | undefined;
        const scheduled: ScheduledTask[] = [];
        const attempts: MediaStartupAttempt[] = [];
        const controller = createMediaStartupController({
            attachSource: current => {
                attempts.push(current);
                if (current.generation === 1) {
                    return new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
                }
            },
            schedule: (delayMs, callback) => {
                const task = { delayMs, callback, canceled: false };
                scheduled.push(task);
                return () => { task.canceled = true; };
            },
            report: () => undefined
        }, { maxAttempts: 3, retryDelayMs: 250 });

        controller.start();
        controller.restart();
        rejectFirst?.(new Error('late failure'));
        await Promise.resolve();
        await Promise.resolve();

        assert.deepStrictEqual(attempts, [token(1, 1), token(2, 1)]);
        assert.strictEqual(scheduled.length, 0);
    });

    test('synchronous attach failure is bounded when only one attempt is allowed', () => {
        const reports: string[] = [];
        let scheduleCount = 0;
        const controller = createMediaStartupController({
            attachSource: () => { throw new Error('sync failure'); },
            schedule: () => {
                scheduleCount += 1;
                return () => undefined;
            },
            report: event => { reports.push(event); }
        }, { maxAttempts: 1, retryDelayMs: 250 });

        assert.doesNotThrow(() => controller.start());
        assert.strictEqual(scheduleCount, 0);
        assert.strictEqual(reports.filter(event => event === 'retry-exhausted').length, 1);
    });
});
