import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    ensureInjectionWritten,
    executeInjection,
    getWorkbenchTransparencyCss,
    hasCurrentInjection,
    runInjectionStep,
    WorkbenchInjectionError,
} from '../core/injector';

suite('Injector security boundary', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'injector.ts'), 'utf-8');

    test('wallpaper iframe sandbox excludes same-origin access', () => {
        assert.match(source, /setAttribute\('sandbox',\s*'\$\{getWallpaperIframeSandbox\(\)\}'\)/);
        assert.match(source, /return 'allow-scripts';/);
        assert.ok(!source.includes('allow-same-origin'));
        assert.ok(!source.includes('srcdoc'));
        assert.ok(!source.includes('document.write'));
    });

    test('custom JavaScript is never copied into Workbench injection', () => {
        assert.ok(!source.includes('customJs'));
    });

    test('Workbench CSP remains restrictive', () => {
        assert.ok(!source.includes('default-src *'));
        assert.ok(!source.includes("script-src * 'unsafe-inline'"));
        assert.match(source, /addSourceToDirective\(contentMatch\[1\], 'frame-src', serverOrigin\)/);
        assert.match(source, /addSourceToDirective\(restrictedContent, 'connect-src', serverOrigin\)/);
    });

    test('Workbench root layers remain transparent so the wallpaper can stay behind the UI', () => {
        const css = getWorkbenchTransparencyCss();
        assert.match(css, /html\s*,\s*body/);
        assert.match(css, /\.monaco-workbench/);
        assert.match(css, /\.monaco-grid-view/);
        assert.match(css, /--modern-ui-shell-background:\s*transparent\s*!important/);
        assert.match(css, /div\[role="application"\]/);
        assert.match(css, /background:\s*transparent\s*!important/);
    });

    test('Workbench restoration delegates user feedback to the extension host', () => {
        assert.ok(!source.includes('showInformationMessage'));
        assert.ok(!source.includes('showErrorMessage'));
        assert.match(source, /throw new WorkbenchInjectionError\(/);
    });

    test('successful write verification accepts the persisted marker', () => {
        assert.doesNotThrow(() => {
            ensureInjectionWritten(
                'before /* [VSCode-Wallpaper-Injection-Start] */ after',
                '/* [VSCode-Wallpaper-Injection-Start] */',
                'workbench.desktop.main.js',
            );
        });
    });

    test('outdated Workbench injections are not treated as current', () => {
        assert.strictEqual(
            hasCurrentInjection('/* [VSCode-Wallpaper-Injection-Start] */ /* [VSCode-Wallpaper-Injection-Version:1] */'),
            false,
        );
        assert.strictEqual(
            hasCurrentInjection('/* [VSCode-Wallpaper-Injection-Start] */ /* [VSCode-Wallpaper-Injection-Version:2] */'),
            true,
        );
    });

    test('failed write verification reports the target path', () => {
        assert.throws(
            () => ensureInjectionWritten('unchanged', 'expected marker', 'workbench.html'),
            /写入校验失败: workbench\.html/,
        );
    });

    test('permission failure remains available as the injection error cause', () => {
        const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const injectionError = new WorkbenchInjectionError(
            'html',
            'Workbench HTML 注入失败: permission denied',
            { cause: permissionError },
        );

        assert.strictEqual(injectionError.stage, 'html');
        assert.strictEqual(injectionError.cause, permissionError);
        assert.strictEqual(injectionError.name, 'WorkbenchInjectionError');
    });

    test('successful injection step resolves only after the write completes', async () => {
        const events: string[] = [];

        await runInjectionStep('javascript', 'Workbench JavaScript 注入失败', async () => {
            await Promise.resolve();
            events.push('written');
        });

        events.push('resolved');
        assert.deepStrictEqual(events, ['written', 'resolved']);
    });

    test('write failure rejects with its original cause and stage', async () => {
        const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });

        await assert.rejects(
            runInjectionStep('javascript', 'Workbench JavaScript 注入失败', async () => {
                throw permissionError;
            }),
            (error: unknown) => {
                assert.ok(error instanceof WorkbenchInjectionError);
                assert.strictEqual(error.stage, 'javascript');
                assert.strictEqual(error.cause, permissionError);
                assert.match(error.message, /Workbench JavaScript 注入失败: permission denied/);
                return true;
            },
        );
    });

    test('injection failure stops before Workbench reload', async () => {
        const events: string[] = [];
        const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });

        await assert.rejects(
            executeInjection({
                patchHtml: async () => { events.push('html'); },
                injectJavaScript: async () => {
                    events.push('javascript');
                    throw permissionError;
                },
                reloadWorkbench: async () => { events.push('reload'); },
            }, true),
            (error: unknown) => error instanceof WorkbenchInjectionError && error.cause === permissionError,
        );

        assert.deepStrictEqual(events, ['html', 'javascript']);
    });

    test('reload runs only after both injection writes succeed', async () => {
        const events: string[] = [];

        await executeInjection({
            patchHtml: async () => { events.push('html'); },
            injectJavaScript: async () => { events.push('javascript'); },
            reloadWorkbench: async () => { events.push('reload'); },
        }, true);

        assert.deepStrictEqual(events, ['html', 'javascript', 'reload']);
    });
});
