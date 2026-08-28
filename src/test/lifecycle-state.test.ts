import * as assert from 'assert';
import { LifecycleState } from '../core/lifecycle-state';

suite('Wallpaper lifecycle state', () => {
    test('allows only one setup or uninstall operation at a time', () => {
        const lifecycle = new LifecycleState();

        assert.strictEqual(lifecycle.tryBegin('setup'), true);
        assert.strictEqual(lifecycle.tryBegin('setup'), false);
        assert.strictEqual(lifecycle.tryBegin('uninstall'), false);
        assert.strictEqual(lifecycle.currentOperation, 'setup');

        lifecycle.end('setup');
        assert.strictEqual(lifecycle.tryBegin('uninstall'), true);
        assert.strictEqual(lifecycle.currentOperation, 'uninstall');
    });

    test('ignores mismatched releases and exposes the disabled gate', () => {
        const lifecycle = new LifecycleState(true);

        assert.strictEqual(lifecycle.disabled, true);
        assert.strictEqual(lifecycle.tryBegin('uninstall'), true);
        lifecycle.end('setup');
        assert.strictEqual(lifecycle.currentOperation, 'uninstall');

        lifecycle.end('uninstall');
        lifecycle.setDisabled(false);
        assert.strictEqual(lifecycle.disabled, false);
        assert.strictEqual(lifecycle.currentOperation, undefined);
    });
});
