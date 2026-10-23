import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseTags, parseInstruction, withSrc, withData, buildTag, compactTags,
    nameInText, srcState, plainText,
} from '../src/tags.js';

test('parses the standard html tag', () => {
    const text = `Hello <img data-iig-instruction='{"style":"anime","prompt":"Axel's book, warm light","aspect_ratio":"16:9"}' src="[IMG:GEN]"> bye`;
    const [t] = parseTags(text);
    assert.equal(t.kind, 'image');
    assert.equal(t.state, 'pending');
    assert.equal(t.data.prompt, "Axel's book, warm light");
    assert.equal(t.data.aspect_ratio, '16:9');
    assert.equal(text.slice(t.index, t.index + t.fullMatch.length), t.fullMatch);
});

test('src inside the prompt does not fool the src detector', () => {
    const text = `<img data-iig-instruction='{"prompt":"a sign reading src=\\"/x.png\\""}' src="[IMG:GEN]">`;
    const [t] = parseTags(text);
    assert.equal(t.src, '[IMG:GEN]');
    const done = withSrc(t, '/user/images/a.png');
    assert.match(done, /src="\/user\/images\/a\.png">$/);
    assert.equal(parseTags(done)[0].state, 'done');
    assert.equal(parseTags(done)[0].data.prompt, t.data.prompt);
});

test('handles src before the instruction and missing src', () => {
    const a = `<img src="[IMG:GEN]" data-iig-instruction='{"prompt":"x"}'>`;
    assert.equal(parseTags(a)[0].src, '[IMG:GEN]');
    const b = `<img data-iig-instruction='{"prompt":"y"}'>`;
    const [t] = parseTags(b);
    assert.equal(t.state, 'pending');
    assert.equal(withSrc(t, '/p.png'), `<img data-iig-instruction='{"prompt":"y"}' src="/p.png">`);
});

test('entity-encoded double-quoted attribute', () => {
    const text = `<img data-iig-instruction="{&quot;prompt&quot;:&quot;cat&quot;,&quot;ar&quot;:&quot;3:2&quot;}" src="[IMG:GEN]">`;
    const [t] = parseTags(text);
    assert.equal(t.data.prompt, 'cat');
    assert.equal(t.data.aspect_ratio, '3:2');
});

test('relaxed parsing of broken JSON', () => {
    const d = parseInstruction(`{"style":"anime","prompt":"she said "hello" softly","aspect_ratio":"1:1",}`);
    assert.equal(d.prompt, 'she said "hello" softly');
    assert.equal(d.aspect_ratio, '1:1');
});

test('video and legacy tags, in document order', () => {
    const text = `[IMG:GEN:{"prompt":"first"}] mid <img data-iig-video='{"prompt":"second","duration":6}' src="[VID:GEN]"> [VID:GEN:{"prompt":"third"}]`;
    const tags = parseTags(text);
    assert.deepEqual(tags.map(t => t.data.prompt), ['first', 'second', 'third']);
    assert.deepEqual(tags.map(t => t.kind), ['image', 'video', 'video']);
    assert.equal(tags[1].data.duration, 6);
    const upgraded = withSrc(tags[0], '/a.png');
    assert.equal(upgraded, `<img data-iig-instruction='{"prompt":"first"}' src="/a.png">`);
});

test('states', () => {
    assert.equal(srcState(''), 'pending');
    assert.equal(srcState('[IMG:GEN]'), 'pending');
    assert.equal(srcState('/scripts/extensions/third-party/x/error.svg'), 'error');
    assert.equal(srcState('/user/images/Bob/iig_1.png'), 'done');
});

test('withData keeps quoting style', () => {
    const [t] = parseTags(`<img data-iig-instruction='{"prompt":"a"}' src="/x.png">`);
    const out = withData(t, { prompt: "b's" });
    assert.equal(parseTags(out)[0].data.prompt, "b's");
    assert.ok(out.includes('src="/x.png"'));
});

test('buildTag round trip with apostrophes and angle brackets', () => {
    const tag = buildTag('image', { prompt: "Lodi's <tiny> hat", aspect_ratio: '1:1', style: '' }, '/f.png');
    const [t] = parseTags(tag);
    assert.equal(t.data.prompt, "Lodi's <tiny> hat");
    assert.equal(t.data.style, undefined);
    assert.equal(t.src, '/f.png');
});

test('compactTags only touches finished tags', () => {
    const text = `a <img data-iig-instruction='{"prompt":"done one"}' src="/x.png"> b <img data-iig-instruction='{"prompt":"todo"}' src="[IMG:GEN]">`;
    const out = compactTags(text);
    assert.ok(out.includes('[image shown: done one]'));
    assert.ok(out.includes('[IMG:GEN]'));
});

test('unicode whole-word alias matching', () => {
    assert.ok(nameInText('Elodie, Lodi', 'Lodi waves hello'));
    assert.ok(!nameInText('Lodi', 'melodies playing'));
    assert.ok(nameInText('Élodie', 'portrait of élodie at dusk'));
    assert.ok(nameInText('Аня', 'Аня улыбается'));
    assert.ok(!nameInText('Аня', 'Анямка'));
    assert.ok(!nameInText('', 'anything'));
    assert.ok(nameInText('C.J.', 'C.J. laughs'));
});

test('plainText strips tags and html', () => {
    const s = plainText(`<p>Hi <b>there</b></p><img data-iig-instruction='{"prompt":"x"}' src="[IMG:GEN]"><style>p{}</style>`);
    assert.equal(s, 'Hi there');
});
