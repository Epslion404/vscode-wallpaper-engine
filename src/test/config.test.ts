import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppConfig, getConfigValidationError, validateConfig } from '../config';

suite('Config Test Suite', () => {
    test('validateConfig should return false for empty path', () => {
        const config: AppConfig = {
            workshopPath: '', 
            opacity: 0.5,
            serverPort: 23333,
            wallpaperId: '',
            resizeDelay: 500,
            startupCheckInterval: 300,
            customCss: '',
            themeCompatibility: 'auto',
            uiLanguage: 'auto'
        };
        const result = validateConfig(config);
        assert.strictEqual(result, false);
        assert.match(getConfigValidationError(config) ?? '', /创意工坊目录/);
    });

    test('validateConfig should reject a file path', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-wallpaper-config-test-'));
        const filePath = path.join(tempDir, 'not-a-directory');
        fs.writeFileSync(filePath, 'test');

        try {
            const config: AppConfig = {
                workshopPath: filePath,
                opacity: 0.5,
                serverPort: 23333,
                wallpaperId: '',
                resizeDelay: 500,
                startupCheckInterval: 300,
                customCss: '',
                themeCompatibility: 'auto',
                uiLanguage: 'auto'
            };
            const result = validateConfig(config);

            assert.strictEqual(result, false);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
