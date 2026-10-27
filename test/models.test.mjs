import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelCaps, nearestRatio, clampSize, gptFreeSize, gptStandardSize } from '../src/models.js';

test('model families', () => {
    assert.equal(modelCaps('gemini-3-pro-image').label, 'Nano Banana Pro');
    assert.equal(modelCaps('nano-banana-pro-preview').label, 'Nano Banana Pro');
    assert.equal(modelCaps('google/gemini-2.5-flash-image').label, 'Nano Banana');
    assert.equal(modelCaps('gemini-3.1-flash-image').label, 'Nano Banana 2');
    assert.equal(modelCaps('gemini-3.1-flash-lite-image').label, 'Nano Banana 2 Lite');
    assert.equal(modelCaps('gemini-nano-banana-2.1').label, 'Nano Banana 2.1');
    assert.equal(modelCaps('gpt-image-2.5-flare').label, 'GPT Image 2.5');
    assert.equal(modelCaps('gpt-image-2-2026-04-21').label, 'GPT Image 2');
    assert.equal(modelCaps('gpt-image-1-mini').label, 'GPT Image 1 mini');
    assert.equal(modelCaps('gpt-image-1.5').label, 'GPT Image 1.x');
    assert.equal(modelCaps('flux-dev').family, 'other');
});

test('ratio and size clamping', () => {
    const gem = modelCaps('gemini-3-pro-image');
    assert.equal(nearestRatio('4:5', gem.ratios), '3:4');
    assert.equal(nearestRatio('5:4', gem.ratios), '4:3');
    assert.equal(nearestRatio('16:9', gem.ratios), '16:9');
    assert.equal(clampSize('4K', modelCaps('gemini-2.5-flash-image').sizes), '1K');
    assert.equal(clampSize('2K', gem.sizes), '2K');
});

test('gpt free sizes obey the API constraints', () => {
    for (const ar of ['1:1', '16:9', '9:16', '21:9', '4:5', '2:3']) {
        for (const size of ['1K', '2K', '4K']) {
            const [w, h] = gptFreeSize(ar, size).split('x').map(Number);
            assert.equal(w % 16, 0);
            assert.equal(h % 16, 0);
            assert.ok(w * h <= 3840 * 2160, `${ar} ${size} too big`);
            assert.ok(Math.max(w, h) <= 3840);
            assert.ok(Math.max(w / h, h / w) <= 3.0001);
        }
    }
    assert.equal(gptFreeSize('16:9', '4K'), '3840x2160');
    assert.equal(gptFreeSize('16:9', '1K'), '1536x864');
    assert.equal(gptStandardSize('16:9'), '1536x1024');
    assert.equal(gptStandardSize('3:4'), '1024x1536');
});

import { bestModel, isImageModelId, sizeFor } from '../src/models.js';

test('picks the best image model the key actually has', () => {
    assert.equal(bestModel(['gemini-2.5-flash', 'gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'imagen-4.0-generate-001']), 'gemini-3-pro-image-preview');
    assert.equal(bestModel(['gpt-4o', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3', 'whisper-1']), 'gpt-image-1');
    assert.equal(bestModel(['gpt-image-2', 'gpt-image-2-2026-04-21']), 'gpt-image-2', 'stable id beats dated snapshot');
    assert.equal(bestModel(['imagen-4.0-generate-001', 'text-embedding-004']), null, 'Imagen is not usable here');
    assert.equal(bestModel([]), null);
});

test('image model filter', () => {
    assert.ok(isImageModelId('google/gemini-2.5-flash-image'));
    assert.ok(isImageModelId('gpt-image-2.5-flare'));
    assert.ok(!isImageModelId('gemini-2.5-flash'));
    assert.ok(!isImageModelId('veo-3.0-generate'));
    assert.ok(!isImageModelId('gemini-3.1-flash-tts-preview'));
});

test('auto resolution per model', () => {
    assert.equal(sizeFor('gemini-3-pro-image-preview'), '2K');
    assert.equal(sizeFor('gemini-2.5-flash-image', 'auto'), '1K');
    assert.equal(sizeFor('gemini-2.5-flash-image', '4K'), '1K', 'clamped to what the model can make');
    assert.equal(sizeFor('gpt-image-2', '2K'), '2K');
    assert.equal(sizeFor('gpt-image-1', '4K'), '1K');
});
