export type ServerTakeoverProbeResult = 'matching' | 'mismatched' | 'absent' | 'occupied';
export type ServerTakeoverClaimResult = 'claimed' | 'contended';
export type ServerTakeoverEvent =
    | 'follow-owner'
    | 'owner-lost'
    | 'claim-attempt'
    | 'claim-won'
    | 'claim-lost'
    | 'superseded'
    | 'cancelled'
    | 'terminal-error';

export type CancelScheduledTask = () => void;

export interface ServerTakeoverMonitorOptions {
    pollIntervalMs: number;
    probe(signal: AbortSignal): Promise<ServerTakeoverProbeResult>;
    claim(signal: AbortSignal): Promise<ServerTakeoverClaimResult>;
    schedule(delayMs: number, task: () => Promise<void>): CancelScheduledTask;
    report(event: ServerTakeoverEvent, error?: unknown): void;
}

/**
 * 监视被复用的壁纸服务，并在原 owner 消失后竞争接管端口。
 *
 * 监控器只管理串行 probe/claim 与取消代次；HTTP server 的创建和关闭仍由
 * WallpaperServer 负责，避免复制服务路由或引入第二套所有权状态。
 */
export class ServerTakeoverMonitor {
    private generation = 0;
    private running = false;
    private cancelScheduled: CancelScheduledTask | null = null;
    private abortController: AbortController | null = null;

    public constructor(private readonly options: ServerTakeoverMonitorOptions) {}

    public start(): void {
        this.stop(false);
        this.running = true;
        this.abortController = new AbortController();
        this.options.report('follow-owner');
        this.scheduleNext(this.generation);
    }

    public stop(reportCancellation = true): void {
        const wasRunning = this.running;
        this.generation += 1;
        this.running = false;
        this.cancelScheduled?.();
        this.cancelScheduled = null;
        this.abortController?.abort();
        this.abortController = null;
        if (wasRunning && reportCancellation) {
            this.options.report('cancelled');
        }
    }

    public isRunning(): boolean {
        return this.running;
    }

    private scheduleNext(generation: number): void {
        if (!this.isCurrent(generation)) {
            return;
        }
        this.cancelScheduled?.();
        this.cancelScheduled = this.options.schedule(this.options.pollIntervalMs, async () => {
            this.cancelScheduled = null;
            await this.tick(generation);
        });
    }

    private async tick(generation: number): Promise<void> {
        const signal = this.abortController?.signal;
        if (!signal || !this.isCurrent(generation)) {
            return;
        }

        try {
            const probe = await this.options.probe(signal);
            if (!this.isCurrent(generation)) {
                return;
            }
            if (probe === 'matching') {
                this.scheduleNext(generation);
                return;
            }
            if (probe === 'mismatched') {
                this.options.report('superseded');
                this.stop(false);
                return;
            }
            if (probe === 'occupied') {
                this.options.report('terminal-error', new Error('壁纸服务端口已被非匹配服务占用'));
                this.stop(false);
                return;
            }

            this.options.report('owner-lost');
            this.options.report('claim-attempt');
            const claim = await this.options.claim(signal);
            if (!this.isCurrent(generation)) {
                return;
            }
            if (claim === 'claimed') {
                this.options.report('claim-won');
                this.stop(false);
                return;
            }
            this.options.report('claim-lost');
            this.scheduleNext(generation);
        } catch (error) {
            if (!this.isCurrent(generation) || signal.aborted) {
                return;
            }
            this.options.report('terminal-error', error);
            this.stop(false);
        }
    }

    private isCurrent(generation: number): boolean {
        return this.running && generation === this.generation;
    }
}

export function scheduleTakeoverTask(delayMs: number, task: () => Promise<void>): CancelScheduledTask {
    const timer = setTimeout(() => {
        void task().catch(error => {
            console.error('[Server takeover] Scheduled task failed:', error);
        });
    }, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
}
