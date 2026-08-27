import * as assert from 'assert';
import { toUserErrorReason } from '../core/user-message';

suite('User-facing error message safety', () => {
    test('maps common filesystem and server errors to concise Chinese reasons', () => {
        assert.strictEqual(
            toUserErrorReason(Object.assign(new Error("EACCES: permission denied, open 'C:\\Users\\Alice\\workbench.html'"), { code: 'EACCES' })),
            '权限不足，无法访问所需文件。',
        );
        assert.strictEqual(
            toUserErrorReason(Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:23333'), { code: 'EADDRINUSE' })),
            '本地服务端口已被占用。',
        );
        assert.strictEqual(
            toUserErrorReason(Object.assign(new Error("ENOENT: no such file or directory, stat '/home/alice/wallpaper/index.html'"), { code: 'ENOENT' })),
            '所需文件不存在或已被移动。',
        );
    });

    test('removes Windows and Unix absolute paths from generic messages', () => {
        const reason = toUserErrorReason(
            new Error('写入 D:\\Documents\\Code\\secret\\workbench.js 失败；备份位于 /home/alice/private/workbench.bak'),
        );

        assert.ok(!reason.includes('D:\\Documents'));
        assert.ok(!reason.includes('/home/alice'));
        assert.match(reason, /相关路径/);
    });

    test('removes control characters and normalizes whitespace', () => {
        const reason = toUserErrorReason(new Error('请求失败\u0000\r\n\t请稍后重试\u001b[31m'));

        assert.strictEqual(reason, '请求失败 请稍后重试');
        assert.doesNotMatch(reason, /[\u0000-\u001f\u007f]/);
    });

    test('limits generic messages without splitting a surrogate pair', () => {
        const reason = toUserErrorReason(new Error(`服务器返回：${'错'.repeat(200)}😀`), 48);

        assert.ok(reason.length <= 48);
        assert.ok(reason.endsWith('…'));
        assert.doesNotMatch(reason, /[\uD800-\uDBFF]$/);
    });

    test('uses a safe fallback for empty and non-error values', () => {
        assert.strictEqual(toUserErrorReason(new Error('\u0000\r\n')), '发生未知错误，请重试。');
        assert.strictEqual(toUserErrorReason(undefined), '发生未知错误，请重试。');
    });
});
