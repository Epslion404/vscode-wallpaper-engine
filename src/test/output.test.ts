import * as assert from 'assert';
import { describeError } from '../core/output';

suite('Wallpaper output diagnostics', () => {
    test('redacts local paths from nested error details', () => {
        const cause = new Error('读取 C:\\Users\\Alice\\secret\\wallpaper.html 失败');
        const error = new Error('注入失败', { cause });
        const text = describeError(error);

        assert.strictEqual(text.includes('C:\\Users\\Alice'), false);
        assert.strictEqual(text.includes('相关路径'), true);
        assert.match(text, /Cause:/);
    });
});
