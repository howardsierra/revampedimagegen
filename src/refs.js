/*
 * Revamped Image Gen — character reference matching and loading.
 * Licensed under AGPL-3.0-or-later.
 */

import { modelCaps } from './models.js';
import { activeRefs, settings } from './settings.js';
import { getCharName, getUserName, log } from './st.js';
import { loadAsDataUrl } from './storage.js';
import { nameInText, splitAliases } from './tags.js';

const cache = new Map(); // path -> dataUrl (LRU)
const CACHE_MAX = 16;

export function clearRefCache(path) {
    if (path) cache.delete(path);
    else cache.clear();
}

async function load(path) {
    if (cache.has(path)) {
        const v = cache.get(path);
        cache.delete(path);
        cache.set(path, v);
        return v;
    }
    const v = await loadAsDataUrl(path);
    cache.set(path, v);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return v;
}

/** Name used for matching: the slot's aliases, else the live character/persona name. */
export function slotNames(slot, kind) {
    if (splitAliases(slot.name).length) return slot.name;
    if (kind === 'char') return getCharName();
    if (kind === 'user') return getUserName();
    return '';
}

/** Max references per request: the user's number, or the model's sensible default (0 = auto). */
export function maxRefsFor(model = settings().model) {
    const caps = modelCaps(model);
    const n = Number(settings().maxRefs) || 0;
    const limit = caps.hardRefs || 16;
    return n > 0 ? Math.min(n, limit) : Math.max(1, caps.maxRefs || 4);
}

/**
 * Which reference slots apply to `promptText`, in priority order
 * (char → user → NPCs), capped at maxRefs. Pure apart from reading settings.
 */
export function matchRefs(promptText, { refs = activeRefs(), max = maxRefsFor() } = {}) {
    const out = [];
    const consider = (slot, kind, label) => {
        if (!slot?.path || out.length >= max) return;
        const names = slotNames(slot, kind);
        const hit = slot.always || nameInText(names, promptText);
        if (hit) out.push({ kind, label, name: splitAliases(names)[0] || label, path: slot.path, reason: slot.always ? 'always' : 'name', layer: slot.layer || 'global' });
    };
    consider(refs.char, 'char', 'Character');
    consider(refs.user, 'user', 'You');
    for (const npc of refs.npcs || []) consider(npc, 'npc', 'NPC');
    return out;
}

/** Load matched references as data URLs. Missing files are skipped with a warning. */
export async function collectRefs(promptText, opts) {
    const matched = matchRefs(promptText, opts);
    const urls = [];
    const labels = [];
    for (const m of matched) {
        try {
            urls.push(await load(m.path));
            labels.push(m.name);
        } catch (e) {
            log('warn', `Reference for ${m.name} could not be loaded: ${e.message}`);
        }
    }
    if (matched.length) log('info', `References: ${matched.map(m => `${m.name} (${m.reason})`).join(', ')}`);
    return { urls, labels, matched };
}

/** Distinct names that have a reference photo — fed to the LLM instruction. */
export function knownRefNames() {
    const refs = activeRefs();
    const names = [];
    const add = (slot, kind) => {
        if (!slot?.path) return;
        const n = splitAliases(slotNames(slot, kind))[0];
        if (n && !names.includes(n)) names.push(n);
    };
    add(refs.char, 'char');
    add(refs.user, 'user');
    for (const npc of refs.npcs || []) add(npc, 'npc');
    return names;
}
