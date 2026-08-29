import * as assert from 'assert';
import { parseSingleByteRange } from '../core/server-media';

suite('Current Media Range Test Suite', () => {
    test('parses fixed, open-ended and suffix ranges', () => {
        assert.deepStrictEqual(parseSingleByteRange('bytes=0-2', 10), { start: 0, end: 2 });
        assert.deepStrictEqual(parseSingleByteRange('bytes=3-5', 10), { start: 3, end: 5 });
        assert.deepStrictEqual(parseSingleByteRange('bytes=7-', 10), { start: 7, end: 9 });
        assert.deepStrictEqual(parseSingleByteRange('bytes=-3', 10), { start: 7, end: 9 });
        assert.deepStrictEqual(parseSingleByteRange('bytes=-20', 10), { start: 0, end: 9 });
        assert.deepStrictEqual(parseSingleByteRange('bytes=8-20', 10), { start: 8, end: 9 });
    });

    test('rejects unsatisfiable, multipart and empty-file ranges', () => {
        for (const range of [
            'bytes=10-',
            'bytes=8-7',
            'bytes=0-1,3-4',
            'bytes=-0',
            'bytes=-',
            'items=0-1'
        ]) {
            assert.strictEqual(parseSingleByteRange(range, 10), undefined, range);
        }
        assert.strictEqual(parseSingleByteRange('bytes=0-0', 0), undefined);
    });
});
