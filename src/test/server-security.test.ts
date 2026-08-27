import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPathWithinRealRoot, isPrivateAddress, validateProxyTarget } from '../core/server-security';

suite('Server security helpers', () => {
    test('rejects loopback, private and metadata addresses', () => {
        assert.strictEqual(isPrivateAddress('127.0.0.1'), true);
        assert.strictEqual(isPrivateAddress('10.0.0.8'), true);
        assert.strictEqual(isPrivateAddress('169.254.169.254'), true);
        assert.strictEqual(isPrivateAddress('8.8.8.8'), false);
        assert.throws(() => validateProxyTarget('http://127.0.0.1:8080/'));
        assert.throws(() => validateProxyTarget('file:///etc/passwd'));
    });

    test('uses real paths to reject symlink escape', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-security-'));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-outside-'));
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
        const link = path.join(root, 'link.txt');
        try {
            fs.symlinkSync(path.join(outside, 'secret.txt'), link, 'file');
        } catch {
            return;
        }
        assert.strictEqual(isPathWithinRealRoot(root, link), false);
        assert.strictEqual(isPathWithinRealRoot(root, root), true);
    });
});
