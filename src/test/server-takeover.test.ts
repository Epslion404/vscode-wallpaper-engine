import * as assert from 'assert';
import {
    CancelScheduledTask,
    ServerTakeoverClaimResult,
    ServerTakeoverEvent,
    ServerTakeoverMonitor,
    ServerTakeoverProbeResult
} from '../core/server-takeover';

type ScheduledTask = { cancelled: boolean; run: () => Promise<void> };

class ManualScheduler {
    private readonly tasks: ScheduledTask[] = [];

    public readonly schedule = (_delayMs: number, run: () => Promise<void>): CancelScheduledTask => {
        const task = { cancelled: false, run };
        this.tasks.push(task);
        return () => {
            task.cancelled = true;
        };
    };

    public async runNext(includeCancelled = false): Promise<void> {
        const index = this.tasks.findIndex(task => includeCancelled || !task.cancelled);
        assert.notStrictEqual(index, -1, 'expected a scheduled takeover task');
        const [task] = this.tasks.splice(index, 1);
        await task.run();
    }

    public pendingCount(): number {
        return this.tasks.filter(task => !task.cancelled).length;
    }
}

function createMonitor(
    scheduler: ManualScheduler,
    probes: ServerTakeoverProbeResult[],
    claims: ServerTakeoverClaimResult[],
    events: ServerTakeoverEvent[]
): ServerTakeoverMonitor {
    return new ServerTakeoverMonitor({
        pollIntervalMs: 500,
        probe: async () => probes.shift() ?? 'matching',
        claim: async () => claims.shift() ?? 'claimed',
        schedule: scheduler.schedule,
        report: event => events.push(event)
    });
}

suite('ServerTakeoverMonitor', () => {
    test('keeps following a healthy matching owner without claiming', async () => {
        const scheduler = new ManualScheduler();
        const events: ServerTakeoverEvent[] = [];
        const monitor = createMonitor(scheduler, ['matching', 'matching'], [], events);

        monitor.start();
        await scheduler.runNext();
        await scheduler.runNext();

        assert.deepStrictEqual(events, ['follow-owner']);
        assert.strictEqual(monitor.isRunning(), true);
        assert.strictEqual(scheduler.pendingCount(), 1);
        monitor.stop();
    });

    test('claims after the owner disappears and stops scheduling', async () => {
        const scheduler = new ManualScheduler();
        const events: ServerTakeoverEvent[] = [];
        const monitor = createMonitor(scheduler, ['absent'], ['claimed'], events);

        monitor.start();
        await scheduler.runNext();

        assert.deepStrictEqual(events, ['follow-owner', 'owner-lost', 'claim-attempt', 'claim-won']);
        assert.strictEqual(monitor.isRunning(), false);
        assert.strictEqual(scheduler.pendingCount(), 0);
    });

    test('retries probing after losing a claim race', async () => {
        const scheduler = new ManualScheduler();
        const events: ServerTakeoverEvent[] = [];
        const monitor = createMonitor(scheduler, ['absent', 'matching'], ['contended'], events);

        monitor.start();
        await scheduler.runNext();
        await scheduler.runNext();

        assert.deepStrictEqual(events, ['follow-owner', 'owner-lost', 'claim-attempt', 'claim-lost']);
        assert.strictEqual(monitor.isRunning(), true);
        assert.strictEqual(scheduler.pendingCount(), 1);
        monitor.stop();
    });

    test('stop invalidates a cancelled task that has already entered the queue', async () => {
        const scheduler = new ManualScheduler();
        const events: ServerTakeoverEvent[] = [];
        const monitor = createMonitor(scheduler, ['absent'], ['claimed'], events);

        monitor.start();
        monitor.stop();
        await scheduler.runNext(true);

        assert.deepStrictEqual(events, ['follow-owner', 'cancelled']);
        assert.strictEqual(monitor.isRunning(), false);
        assert.strictEqual(scheduler.pendingCount(), 0);
    });

    test('mismatched and occupied owners terminate without claiming', async () => {
        for (const probe of ['mismatched', 'occupied'] as const) {
            const scheduler = new ManualScheduler();
            const events: ServerTakeoverEvent[] = [];
            const monitor = createMonitor(scheduler, [probe], [], events);

            monitor.start();
            await scheduler.runNext();

            assert.strictEqual(monitor.isRunning(), false);
            assert.strictEqual(scheduler.pendingCount(), 0);
            assert.strictEqual(events.at(-1), probe === 'mismatched' ? 'superseded' : 'terminal-error');
        }
    });
});
