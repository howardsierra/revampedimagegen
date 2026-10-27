import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatExamples, pickExamples } from '../src/examples.js';

test('character examples win over global ones; disabled and empty are skipped', () => {
    const global = [{ text: 'g1' }, { text: 'g2', enabled: false }, { text: '  ' }, { text: 'g3' }];
    assert.deepEqual(pickExamples({ global, max: 3 }), ['g1', 'g3']);
    assert.deepEqual(pickExamples({ global, character: [{ text: 'c1' }], max: 3 }), ['c1']);
    assert.deepEqual(pickExamples({ global, character: [{ text: 'c1', enabled: false }], max: 3 }), ['g1', 'g3']);
    assert.deepEqual(pickExamples({ global, max: 1 }), ['g1']);
    assert.deepEqual(pickExamples({ global, max: 0 }), []);
});

test('formatted block', () => {
    assert.equal(formatExamples([]), '');
    const out = formatExamples(['a  b\nc', 'd']);
    assert.match(out, /^- Write PROMPT in the same style/);
    assert.match(out, /Example 1: a b c\n {2}Example 2: d$/);
});
