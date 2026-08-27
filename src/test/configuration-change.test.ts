import * as assert from 'assert';
import { classifyConfigurationChange } from '../configuration-change';

suite('Configuration Change Test Suite', () => {
    test('classifies published settings by the runtime work they require', () => {
        assert.deepStrictEqual(classifyConfigurationChange(['transparencyEnabled']), {
            wallpaper: false,
            transparency: true
        });
        assert.deepStrictEqual(classifyConfigurationChange(['workshopPath']), {
            wallpaper: true,
            transparency: false
        });
        assert.deepStrictEqual(classifyConfigurationChange(['serverPort']), {
            wallpaper: true,
            transparency: false
        });
        assert.deepStrictEqual(classifyConfigurationChange(['transparentOpacity']), {
            wallpaper: false,
            transparency: false
        });
    });
});
