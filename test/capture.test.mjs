import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCapture, defaultRules, parseFlags, compileRule, formatInstructions } from '../src/capture.js';
import { parseTags } from '../src/tags.js';

const on = (...ids) => defaultRules().map(r => ({ ...r, enabled: ids.includes(r.id) }));

test('bracket rule → pending tag with flags', () => {
    const { text, captured } = applyCapture('She smiles. [IMG: Elodie on the pier at dawn --ar 16:9 --style watercolor --no text] The end.', on('bracket'));
    assert.equal(captured.length, 1);
    const [t] = parseTags(text);
    assert.equal(t.state, 'pending');
    assert.equal(t.data.prompt, 'Elodie on the pier at dawn');
    assert.equal(t.data.aspect_ratio, '16:9');
    assert.equal(t.data.style, 'watercolor');
    assert.equal(t.data.negative_prompt, 'text');
    assert.ok(text.startsWith('She smiles. <img data-iig-instruction='));
    assert.ok(text.endsWith(' The end.'));
});

test('bracket rule ignores our own markers and legacy tags', () => {
    const src = `[IMG:GEN:{"prompt":"x y z"}] [image shown: old one] <img data-iig-instruction='{"prompt":"[IMG: nested]"}' src="[IMG:GEN]">`;
    const { text, captured } = applyCapture(src, on('bracket'));
    assert.equal(captured.length, 0);
    assert.equal(text, src);
});

test('xml, hidden comment and line rules', () => {
    const src = `<image>Robin reading by candlelight</image>\n<!-- image: a stormy harbour, cinematic -->\n**Image prompt:** Lodi laughing in the rain --ar 3:4`;
    const { text, captured } = applyCapture(src, on('xml', 'comment', 'line'));
    assert.deepEqual(captured.map(c => c.data.prompt), ['Robin reading by candlelight', 'a stormy harbour, cinematic', 'Lodi laughing in the rain']);
    assert.equal(parseTags(text).length, 3);
    assert.equal(parseTags(text)[2].data.aspect_ratio, '3:4');
});

test('custom rule with named groups and keepText', () => {
    const rule = { id: 'c', enabled: true, pattern: String.raw`\{\{pic\|(?<style>[^|]+)\|(?<prompt>[^}]+)\}\}`, flags: 'g', keepText: true };
    const { text, captured } = applyCapture('A {{pic|anime|Axel waves}} b', [rule]);
    assert.equal(captured[0].data.style, 'anime');
    assert.equal(captured[0].data.prompt, 'Axel waves');
    assert.ok(text.includes('{{pic|anime|Axel waves}}\n<img'));
});

test('unnamed first group works; invalid regex reported, not thrown', () => {
    const r1 = { id: 'u', enabled: true, pattern: String.raw`\(\(draw (.+?)\)\)`, flags: 'g' };
    const r2 = { id: 'bad', name: 'bad', enabled: true, pattern: '([unclosed', flags: 'g' };
    const { captured, errors } = applyCapture('((draw a red fox in snow))', [r1, r2]);
    assert.equal(captured[0].data.prompt, 'a red fox in snow');
    assert.equal(errors.length, 1);
    assert.equal(compileRule(r2).re, null);
});

test('invalid aspect ratio flag is dropped; html inside prompt stripped', () => {
    const { captured } = applyCapture('<image><b>a lighthouse</b> --ar 7:5</image>', on('xml'));
    assert.equal(captured[0].data.prompt, 'a lighthouse');
    assert.equal(captured[0].data.aspect_ratio, undefined);
});

test('parseFlags and instructions', () => {
    assert.deepEqual(parseFlags('cat --size 2k --seed 42'), { prompt: 'cat', image_size: '2K', seed: 42 });
    assert.match(formatInstructions('bracket'), /\[IMG: PROMPT --ar 16:9\]/);
    assert.match(formatInstructions('html'), /data-iig-instruction/);
});

test('Clover <ooc> image order → pending tag', () => {
    const src = 'She waits.\n<ooc>\nImage generation: Ciara on a rooftop at dusk, wind in her hair --ar 9x16\n</ooc>\n<ooc>Make it rain more.</ooc>';
    const { text, captured } = applyCapture(src, on('clover'));
    assert.equal(captured.length, 1);
    const [t] = parseTags(text);
    assert.equal(t.data.prompt, 'Ciara on a rooftop at dusk, wind in her hair');
    assert.equal(t.data.aspect_ratio, '9:16');
    assert.ok(text.includes('<ooc>Make it rain more.</ooc>'), 'non-image OOC is left alone');
    assert.ok(!text.includes('Image generation'));
});

test('--ar only takes the ratio; trailing words stay in the prompt', () => {
    const d = parseFlags('Jun laughing --ar 3:4 under neon');
    assert.equal(d.aspect_ratio, '3:4');
    assert.equal(d.prompt.replace(/\s+/g, ' ').trim(), 'Jun laughing under neon');
});
