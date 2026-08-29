import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    addSourceToDirective,
    ensureInjectionWritten,
    executeInjection,
    getWorkbenchPathCandidates,
    getWorkbenchTransparencyCss,
    hasCurrentInjection,
    isBackgroundVideoPowerPause,
    patchWorkbenchScriptVersion,
    patchWorkbenchCspContent,
    runInjectionStep,
    selectWorkbenchPath,
    stripWorkbenchInjection,
    stripWorkbenchScriptVersion,
    stripManagedLocalOriginsFromCspContent,
    WorkbenchInjectionError,
} from '../core/injector';

suite('Injector security boundary', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'injector.ts'), 'utf-8');

    test('recognizes only the Chromium background video power pause AbortError', () => {
        const powerPause = new Error(
            'The play() request was interrupted because video-only background media was paused to save power.'
        );
        powerPause.name = 'AbortError';
        const unrelatedAbort = new Error('The play() request was interrupted by a call to pause().');
        unrelatedAbort.name = 'AbortError';

        assert.strictEqual(isBackgroundVideoPowerPause(powerPause), true);
        assert.strictEqual(isBackgroundVideoPowerPause({
            name: 'AbortError',
            message: powerPause.message
        }), true);
        assert.strictEqual(isBackgroundVideoPowerPause(unrelatedAbort), false);
        assert.strictEqual(isBackgroundVideoPowerPause(new Error(powerPause.message)), false);
        assert.strictEqual(isBackgroundVideoPowerPause('AbortError'), false);
    });

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
        assert.match(source, /patchWorkbenchCspContent\(contentMatch\[1\], port\)/);
        for (const directive of ['frame-src', 'connect-src', 'media-src', 'img-src']) {
            assert.ok(source.includes(`'${directive}'`));
        }
    });

    test('CSP helper adds a missing directive and replaces stale loopback origins', () => {
        assert.strictEqual(
            addSourceToDirective("default-src 'none';", 'media-src', 'http://127.0.0.1:23333'),
            "default-src 'none'; media-src http://127.0.0.1:23333;",
        );
        assert.strictEqual(
            addSourceToDirective(
                "media-src 'self' http://127.0.0.1:12345;",
                'media-src',
                'http://127.0.0.1:23333',
            ),
            "media-src 'self' http://127.0.0.1:23333;",
        );
    });

    test('Workbench CSP authorizes only the current loopback origin for every media directive', () => {
        const patched = patchWorkbenchCspContent(
            "default-src 'none'; img-src 'self' http://127.0.0.1:12345;",
            23333,
        );

        for (const directive of ['frame-src', 'connect-src', 'media-src', 'img-src']) {
            assert.match(patched, new RegExp(`${directive}[^;]*http://127\\.0\\.0\\.1:23333`));
        }
        assert.match(patched, /img-src 'self' http:\/\/127\.0\.0\.1:23333/);
        assert.ok(!patched.includes('http://127.0.0.1:12345'));
        assert.ok(!patched.includes('unsafe-inline'));
        assert.ok(!patched.includes('unsafe-eval'));
    });

    test('CSP restoration removes loopback origins only from extension-managed directives', () => {
        const restored = stripManagedLocalOriginsFromCspContent(
            "script-src 'self' http://127.0.0.1:9000; img-src 'self' http://127.0.0.1:23333; media-src http://127.0.0.1:23333;",
        );

        assert.match(restored, /script-src 'self' http:\/\/127\.0\.0\.1:9000/);
        assert.match(restored, /img-src 'self';/);
        assert.ok(!restored.includes('media-src http://127.0.0.1:23333'));
    });

    test('Workbench HTML and JavaScript candidates are selected independently and deterministically', () => {
        const root = path.join('C:', 'VSCode', 'resources', 'app');
        const htmlCandidates = getWorkbenchPathCandidates(root, 'html');
        const jsCandidates = getWorkbenchPathCandidates(root, 'js');

        assert.match(htmlCandidates[0], /electron-browser[\\/]workbench[\\/]workbench\.html$/);
        assert.match(jsCandidates[0], /electron-browser[\\/]workbench[\\/]workbench\.js$/);
        assert.match(jsCandidates[jsCandidates.length - 1], /out[\\/]vs[\\/]workbench[\\/]workbench\.desktop\.main\.js$/);
        assert.strictEqual(
            selectWorkbenchPath(htmlCandidates, candidate => candidate === htmlCandidates[0]),
            htmlCandidates[0],
        );
        assert.strictEqual(
            selectWorkbenchPath(
                jsCandidates,
                candidate => candidate === jsCandidates[0] || candidate === jsCandidates[jsCandidates.length - 1],
            ),
            jsCandidates[0],
        );
        assert.strictEqual(selectWorkbenchPath(jsCandidates, () => false), null);
    });

    test('Workbench cleanup removes injection blocks from every candidate content', () => {
        const injected = [
            'before',
            '/* [VSCode-Wallpaper-Injection-Start] */',
            'window.__vscodeWallpaperRuntimeV6 = true;',
            '/* [VSCode-Wallpaper-Injection-End] */',
            'after',
        ].join('\n');

        assert.strictEqual(stripWorkbenchInjection(injected).trim(), 'before\nafter');
    });

    test('Workbench script versioning invalidates module cache and restores unrelated query parameters', () => {
        const html = '<script src="./workbench.js?existing=1" type="module"></script>';
        const patched = patchWorkbenchScriptVersion(html, 'operation-123');

        assert.match(patched, /workbench\.js\?existing=1&amp;vscode-wallpaper=operation-123/);
        assert.strictEqual(stripWorkbenchScriptVersion(patched), html);
    });

    test('Workbench root layers remain transparent so the wallpaper can stay behind the UI', () => {
        const css = getWorkbenchTransparencyCss();
        assert.match(css, /html\s*,\s*body/);
        assert.match(css, /\.monaco-workbench/);
        assert.match(css, /div\[role="application"\]/);
        assert.match(css, /background:\s*transparent\s*!important/);
        assert.match(css, /--modern-ui-shell-background:\s*transparent\s*!important/);
        assert.match(css, /\.monaco-grid-view/);
        assert.match(css, /z-index:\s*1\s*!important/);
        assert.match(css, /isolation:\s*isolate\s*!important/);
    });

    test('runtime reasserts shell transparency after Workbench theme updates', () => {
        assert.match(source, /setManagedStyle\(workbench,\s*'--modern-ui-shell-background',\s*'transparent',\s*'important'\)/);
        assert.match(source, /setManagedStyle\(element,\s*'background-color',\s*'transparent',\s*'important'\)/);
        assert.match(source, /MutationObserver/);
        assert.match(source, /managedInlineStyles/);
        assert.match(source, /original\.priority/);
    });

    test('video uses the bounded loopback media endpoint without embedding its absolute path', () => {
        const videoBranch = source.slice(
            source.indexOf('if (type === WallpaperType.Video)'),
            source.indexOf('} else if (type === WallpaperType.Image)'),
        );
        assert.match(videoBranch, /SERVER_ROOT \+ '\/media\/current\?generation='/);
        assert.ok(!videoBranch.includes('toVsCodeResourceUrl'));
        assert.match(videoBranch, /preload = 'auto'/);
        assert.match(videoBranch, /autoplay = true/);
        assert.match(videoBranch, /loop = true/);
        assert.match(videoBranch, /muted = true/);
        assert.match(videoBranch, /playsInline = true/);
        assert.match(videoBranch, /\.load\(\)/);
        assert.match(videoBranch, /return startVideoPlayback\(token\)/);
        assert.match(videoBranch, /mediaStartupController\.failed\(token,/);
        assert.match(videoBranch, /'loading', 'visibility-deferred'/);
        assert.match(videoBranch, /document\.addEventListener\('visibilitychange'/);
        assert.match(videoBranch, /document\.visibilityState === 'visible'/);
        assert.match(videoBranch, /deferredVideoToken = token/);
        assert.match(videoBranch, /isBackgroundVideoPowerPause\(error\)/);
        assert.match(videoBranch, /visibilityResumeRetryUsed/);
        assert.match(videoBranch, /const isActiveVideoToken = token =>/);
        assert.match(videoBranch, /if \(!isActiveVideoToken\(token\)\) return/);
        assert.match(videoBranch, /activeVideoToken = token/);
        assert.match(videoBranch, /const verifyVideoProgress = token =>/);
        assert.match(videoBranch, /if \(!el\.paused\) \{[\s\S]*verifyVideoProgress\(token\)/);
    });

    test('video and image defer media source attachment to the bounded startup controller', () => {
        const videoBranch = source.slice(
            source.indexOf('if (type === WallpaperType.Video)'),
            source.indexOf('} else if (type === WallpaperType.Image)'),
        );
        const imageBranch = source.slice(
            source.indexOf('} else if (type === WallpaperType.Image)'),
            source.indexOf('} else if (type === WallpaperType.Web)'),
        );

        assert.match(videoBranch, /createMediaStartupController/);
        assert.match(videoBranch, /attachSource:\s*token\s*=>[\s\S]*\/media\/current\?generation=/);
        assert.match(imageBranch, /createMediaStartupController/);
        assert.match(imageBranch, /attachSource:\s*token\s*=>[\s\S]*\/media\/current\?generation=/);
        assert.match(source, /if \(window\.reloadWallpaper\) window\.reloadWallpaper\(\)/);
        assert.match(source, /resp\.ok \|\| resp\.status === 205/);
    });

    test('image also uses the loopback media endpoint without embedding its absolute path', () => {
        const imageBranch = source.slice(
            source.indexOf('} else if (type === WallpaperType.Image)'),
            source.indexOf('} else if (type === WallpaperType.Web)'),
        );
        assert.match(imageBranch, /SERVER_ROOT \+ '\/media\/current\?generation='/);
        assert.ok(!imageBranch.includes('toVsCodeResourceUrl'));
        assert.match(imageBranch, /window\.reloadWallpaper = \(\) =>/);
    });

    test('injected runtime reports bounded playback health for every media type', () => {
        for (const eventName of [
            'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing',
            'pause', 'waiting', 'stalled', 'suspend', 'emptied', 'ended', 'error',
        ]) {
            assert.ok(source.includes(`'${eventName}'`), `missing ${eventName} listener`);
        }
        assert.match(source, /PLAYBACK_EVENT_URL = SERVER_ROOT \+ '\/playback-event'/);
        assert.match(source, /method: 'POST'/);
        assert.match(source, /mode: 'no-cors'/);
        assert.ok(!source.includes("headers: { 'Content-Type': 'application/json' }"));
        assert.match(source, /String\(fields\.detail\)\.slice\(0, 160\)/);
        assert.match(source, /lastPlaybackEvents/);
        assert.match(source, /currentTime > startedAt \+ 0\.05/);
        assert.match(source, /'ready', 'time-progress'/);
        assert.match(source, /failed\(token, 'watchdog-timeout'\)/);
        assert.match(source, /'error', 'retry-exhausted'/);
        assert.match(source, /const failureFields = \{[\s\S]*errorCode:[\s\S]*reportPlayback\('error', 'retry-exhausted', failureFields\)/);
        assert.match(source, /Promise\.resolve\(el\.decode\(\)\)/);
        assert.match(source, /'ready', 'decode'/);
        assert.match(source, /el\.onload = \(\) =>/);
        assert.match(source, /'ready', 'load'/);
        assert.match(source, /el\.onerror = \(\) =>/);
    });

    test('runtime layering and cleanup are stable across reinjection and removal', () => {
        assert.match(source, /container\.style\.zIndex = '0'/);
        assert.match(source, /__vscodeWallpaperRuntimeV7/);
        assert.match(source, /previousRuntime\.cleanup\(\)/);
        assert.match(source, /let container;/);
        assert.match(source, /if \(disposed\) return/);
        assert.match(source, /removalObserver/);
        assert.match(source, /containerRestoreCount < 1/);
        assert.match(source, /'loading', 'container-restored'/);
        assert.match(source, /'error', 'container-removed'/);
        assert.match(source, /transparencyObserver\.disconnect\(\)/);
        assert.match(source, /removeEventListener\('resize', handleResize\)/);
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
            hasCurrentInjection('/* [VSCode-Wallpaper-Injection-Start] */ /* [VSCode-Wallpaper-Injection-Version:3] */'),
            false,
        );
        assert.strictEqual(
            hasCurrentInjection('/* [VSCode-Wallpaper-Injection-Start] */ /* [VSCode-Wallpaper-Injection-Version:4] */'),
            false,
        );
        assert.strictEqual(
            hasCurrentInjection('/* [VSCode-Wallpaper-Injection-Start] */ /* [VSCode-Wallpaper-Injection-Version:5] */'),
            false,
        );
        assert.strictEqual(
            hasCurrentInjection('/* [VSCode-Wallpaper-Injection-Start] */ /* [VSCode-Wallpaper-Injection-Version:6] */'),
            false,
        );
        assert.strictEqual(
            hasCurrentInjection('/* [VSCode-Wallpaper-Injection-Start] */ /* [VSCode-Wallpaper-Injection-Version:7] */'),
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
