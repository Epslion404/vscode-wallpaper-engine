import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

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
});
