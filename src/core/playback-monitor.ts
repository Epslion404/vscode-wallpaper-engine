export type PlaybackMediaType = 'video' | 'image' | 'web';
export type PlaybackRuntimeState = 'idle' | 'loading' | 'ready' | 'error';

export interface PlaybackReport {
    state: Exclude<PlaybackRuntimeState, 'idle'>;
    mediaType: PlaybackMediaType;
    event: string;
    readyState?: number;
    networkState?: number;
    paused?: boolean;
    currentTime?: number;
    errorCode?: number;
    detail?: string;
}

export interface PlaybackSnapshot extends PlaybackReport {
    updatedAt: number;
}

export type PlaybackStatus = { state: 'idle' } | PlaybackSnapshot;

const EVENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_DETAIL_LENGTH = 160;
const REPORT_KEYS = new Set([
    'state',
    'mediaType',
    'event',
    'readyState',
    'networkState',
    'paused',
    'currentTime',
    'errorCode',
    'detail'
]);
const SNAPSHOT_KEYS = new Set([...REPORT_KEYS, 'updatedAt']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalNumberInRange(value: unknown, minimum: number, maximum: number, integer = false): value is number | undefined {
    return value === undefined
        || (typeof value === 'number'
            && Number.isFinite(value)
            && value >= minimum
            && value <= maximum
            && (!integer || Number.isInteger(value)));
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === 'boolean';
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
    return Object.keys(value).every(key => allowed.has(key));
}

/**
 * Workbench 上报属于外部输入，只接受诊断所需的有界字段。
 */
export function parsePlaybackReport(value: unknown): PlaybackReport | undefined {
    if (!isRecord(value)
        || !hasOnlyKeys(value, REPORT_KEYS)
        || (value.state !== 'loading' && value.state !== 'ready' && value.state !== 'error')
        || (value.mediaType !== 'video' && value.mediaType !== 'image' && value.mediaType !== 'web')
        || typeof value.event !== 'string'
        || !EVENT_PATTERN.test(value.event)
        || !isOptionalNumberInRange(value.readyState, 0, 4, true)
        || !isOptionalNumberInRange(value.networkState, 0, 3, true)
        || !isOptionalBoolean(value.paused)
        || !isOptionalNumberInRange(value.currentTime, 0, Number.MAX_SAFE_INTEGER)
        || !isOptionalNumberInRange(value.errorCode, 0, 4, true)
        || (value.detail !== undefined
            && (typeof value.detail !== 'string' || value.detail.length > MAX_DETAIL_LENGTH))) {
        return undefined;
    }
    return {
        state: value.state,
        mediaType: value.mediaType,
        event: value.event,
        ...(value.readyState === undefined ? {} : { readyState: value.readyState }),
        ...(value.networkState === undefined ? {} : { networkState: value.networkState }),
        ...(value.paused === undefined ? {} : { paused: value.paused }),
        ...(value.currentTime === undefined ? {} : { currentTime: value.currentTime }),
        ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
        ...(value.detail === undefined ? {} : { detail: value.detail })
    };
}

/** 严格解析服务端状态响应，拒绝未知字段和无界时间值。 */
export function parsePlaybackStatus(value: unknown): PlaybackStatus | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (value.state === 'idle') {
        return Object.keys(value).length === 1 ? { state: 'idle' } : undefined;
    }
    if (!hasOnlyKeys(value, SNAPSHOT_KEYS)
        || typeof value.updatedAt !== 'number'
        || !Number.isSafeInteger(value.updatedAt)
        || value.updatedAt < 0) {
        return undefined;
    }
    const { updatedAt, ...reportValue } = value;
    const report = parsePlaybackReport(reportValue);
    return report ? { ...report, updatedAt } : undefined;
}

export class PlaybackMonitor {
    private snapshot: PlaybackSnapshot | undefined;

    public reset(): void {
        this.snapshot = undefined;
    }

    public update(report: PlaybackReport, now = Date.now()): PlaybackSnapshot {
        this.snapshot = { ...report, updatedAt: now };
        return this.snapshot;
    }

    public current(): PlaybackSnapshot | undefined {
        return this.snapshot;
    }

}
