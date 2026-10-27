import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal SillyTavern/browser stubs so the settings-backed modules can load.
const store = {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, querySelector: () => null, createElement: () => ({ style: {} }), documentElement: { style: {} }, body: {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.SillyTavern = { getContext: () => ({ extensionSettings: store, chat: [], name1: 'Mina', name2: 'Ciara', characters: [], eventSource: { on() {} }, event_types: {} }) };
globalThis.toastr = {};

const { resolveOptions, parseRefNames } = await import('../src/engine.js');
const { matchRefs } = await import('../src/refs.js');
const { settings } = await import('../src/settings.js');

const refs = {
    char: { name: 'Ciara', path: 'c.png' },
    user: { name: 'Mina', path: 'u.png' },
    npcs: [{ name: 'Jun, Junnie', path: 'j.png' }, { name: 'Bo', path: 'b.png', always: true }],
};

test('ref_names forces those references, ahead of name matches', () => {
    assert.deepEqual(matchRefs('Mina at the window', { refs, max: 4 }).map(m => m.name), ['Mina', 'Bo']);
    const forced = matchRefs('a rainy window', { refs, max: 4, names: ['Junnie', 'ciara'] });
    assert.deepEqual(forced.map(m => [m.name, m.reason]), [['Ciara', 'requested'], ['Jun', 'requested'], ['Bo', 'always']]);
    // Requested references win the limited slots.
    assert.deepEqual(matchRefs('Mina waves', { refs, max: 1, names: 'Jun' }).map(m => m.name), ['Jun']);
});

test('ref_names accepts arrays and comma strings', () => {
    assert.deepEqual(parseRefNames(['Ciara', ' ', 'Mina ']), ['Ciara', 'Mina']);
    assert.deepEqual(parseRefNames('Ciara, Mina;Jun'), ['Ciara', 'Mina', 'Jun']);
    assert.deepEqual(parseRefNames(undefined), []);
    assert.deepEqual(resolveOptions('image', { prompt: 'x', ref_names: 'Ciara' }).refNames, ['Ciara']);
});

test('style false / "none" skips the default style', () => {
    settings().defaultStyle = 'watercolor';
    assert.equal(resolveOptions('image', { prompt: 'x' }).style, 'watercolor');
    assert.equal(resolveOptions('image', { prompt: 'x', style: 'anime' }).style, 'anime');
    assert.equal(resolveOptions('image', { prompt: 'x', style: false }).style, '');
    assert.equal(resolveOptions('image', { prompt: 'x', style: 'None' }).style, '');
    assert.equal(resolveOptions('image', { prompt: 'x', style: false }, { fromStudio: true }).style, '');
    settings().defaultStyle = '';
});

test('no_refs stays truthy-compatible', () => {
    assert.equal(resolveOptions('image', { prompt: 'x', no_refs: true }).noRefs, true);
    assert.equal(resolveOptions('image', { prompt: 'x', no_refs: 1 }).noRefs, true);
    assert.equal(resolveOptions('image', { prompt: 'x', no_refs: 'false' }).noRefs, false);
    assert.equal(resolveOptions('image', { prompt: 'x' }).noRefs, false);
});
