/*
 * Revamped Image Gen — example prompts that teach the chat model how to write
 * image prompts (structure, detail, look). Pure functions (unit-tested).
 * Licensed under AGPL-3.0-or-later.
 */

/**
 * The examples that apply: the character's own list when it has enabled
 * examples (a card can have its own look), otherwise the global list.
 */
export function pickExamples({ global = [], character = [], max = 3 } = {}) {
    const on = (list) => (Array.isArray(list) ? list : []).filter(x => x && x.enabled !== false && String(x.text || '').trim());
    const own = on(character);
    const list = own.length ? own : on(global);
    return list.slice(0, Math.max(0, Number(max) || 0)).map(x => String(x.text).trim());
}

/** The block that replaces {{iig_examples}}: empty when there are no examples. */
export function formatExamples(texts) {
    if (!texts?.length) return '';
    return [
        '- Write PROMPT in the same style, structure and level of detail as these examples (match their look; use the current scene, characters and details, never copy the examples):',
        ...texts.map((t, i) => `  Example ${i + 1}: ${t.replace(/\s+/g, ' ')}`),
    ].join('\n');
}
