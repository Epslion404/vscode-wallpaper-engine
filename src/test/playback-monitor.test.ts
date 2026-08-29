import * as assert from 'assert';
import { parsePlaybackReport, parsePlaybackStatus, PlaybackMonitor } from '../core/playback-monitor';

suite('Playback Monitor Test Suite', () => {
    test('accepts bounded playback diagnostics', () => {
        assert.deepStrictEqual(parsePlaybackReport({
            state: 'ready',
            mediaType: 'video',
            event: 'time-progress',
            readyState: 4,
            networkState: 1,
            paused: false,
            currentTime: 1.25
        }), {
            state: 'ready',
            mediaType: 'video',
            event: 'time-progress',
            readyState: 4,
            networkState: 1,
            paused: false,
            currentTime: 1.25
        });
    });

    test('rejects malformed or oversized reports', () => {
        assert.strictEqual(parsePlaybackReport(null), undefined);
        assert.strictEqual(parsePlaybackReport({ state: 'idle', mediaType: 'video', event: 'load' }), undefined);
        assert.strictEqual(parsePlaybackReport({ state: 'ready', mediaType: 'audio', event: 'load' }), undefined);
        assert.strictEqual(parsePlaybackReport({ state: 'error', mediaType: 'video', event: '../error' }), undefined);
        assert.strictEqual(parsePlaybackReport({
            state: 'error',
            mediaType: 'video',
            event: 'decode-error',
            detail: 'x'.repeat(161)
        }), undefined);
        assert.strictEqual(parsePlaybackReport({
            state: 'ready',
            mediaType: 'video',
            event: 'playing',
            readyState: 5
        }), undefined);
        assert.strictEqual(parsePlaybackReport({
            state: 'error',
            mediaType: 'video',
            event: 'decode-error',
            errorCode: 99
        }), undefined);
    });

    test('stores and resets the latest snapshot', () => {
        const monitor = new PlaybackMonitor();
        const snapshot = monitor.update({
            state: 'loading',
            mediaType: 'web',
            event: 'iframe-load'
        }, 1234);

        assert.deepStrictEqual(monitor.current(), snapshot);
        assert.strictEqual(snapshot.updatedAt, 1234);
        monitor.reset();
        assert.strictEqual(monitor.current(), undefined);
    });

    test('strictly parses bounded playback status snapshots', () => {
        assert.deepStrictEqual(parsePlaybackStatus({ state: 'idle' }), { state: 'idle' });
        assert.deepStrictEqual(parsePlaybackStatus({
            state: 'ready',
            mediaType: 'video',
            event: 'time-progress',
            currentTime: 2,
            updatedAt: 1234
        }), {
            state: 'ready',
            mediaType: 'video',
            event: 'time-progress',
            currentTime: 2,
            updatedAt: 1234
        });
        assert.strictEqual(parsePlaybackStatus({ state: 'idle', unexpected: true }), undefined);
        assert.strictEqual(parsePlaybackStatus({
            state: 'ready',
            mediaType: 'video',
            event: 'playing',
            updatedAt: -1
        }), undefined);
        assert.strictEqual(parsePlaybackStatus({
            state: 'ready',
            mediaType: 'video',
            event: 'playing',
            updatedAt: 1234,
            localPath: 'should-not-be-accepted'
        }), undefined);
    });

});
