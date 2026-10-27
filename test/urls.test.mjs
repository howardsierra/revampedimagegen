import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinUrl, normalizeBase, providerForEndpoint } from '../src/urls.js';

test('no doubled version segment', () => {
    assert.equal(joinUrl('https://nano-gpt.com/api/v1', '/v1/images/generations'), 'https://nano-gpt.com/api/v1/images/generations');
    assert.equal(joinUrl('https://api.openai.com', '/v1/images/generations'), 'https://api.openai.com/v1/images/generations');
    assert.equal(joinUrl('https://x.ai/v1/', '/v1/models'), 'https://x.ai/v1/models');
    assert.equal(joinUrl('https://g.example/v1beta', '/v1beta/models/m:generateContent'), 'https://g.example/v1beta/models/m:generateContent');
    assert.equal(joinUrl('https://g.example/v1', '/v1beta/models'), 'https://g.example/v1/v1beta/models', 'different versions are kept');
    assert.equal(joinUrl('https://openrouter.ai/api', '/v1/chat/completions'), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(joinUrl('https://x.ai/v1', 'images/generations'), 'https://x.ai/v1/images/generations');
});

test('pasted method paths are stripped', () => {
    assert.equal(normalizeBase('https://nano-gpt.com/api/v1/images/generations/'), 'https://nano-gpt.com/api/v1');
    assert.equal(normalizeBase('https://api.openai.com/v1/images/generations'), 'https://api.openai.com/v1');
    assert.equal(joinUrl(normalizeBase('https://api.openai.com/v1/images/generations'), '/v1/images/generations'), 'https://api.openai.com/v1/images/generations');
    assert.equal(normalizeBase('https://g.example/v1beta/models/gemini-x:generateContent'), 'https://g.example');
    assert.equal(normalizeBase('https://nano-gpt.com/api/generate-image'), 'https://nano-gpt.com');
});

test('provider detection by host', () => {
    assert.equal(providerForEndpoint('https://nano-gpt.com/api/v1'), 'nanogpt');
    assert.equal(providerForEndpoint('https://openrouter.ai/api'), 'openrouter');
    assert.equal(providerForEndpoint('https://generativelanguage.googleapis.com'), 'gemini');
    assert.equal(providerForEndpoint('https://my-proxy.example/v1'), null);
    assert.equal(providerForEndpoint(''), null);
});
