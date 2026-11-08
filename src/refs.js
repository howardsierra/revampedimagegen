/*
 * Revamped Image Gen — character reference matching and loading.
 * Licensed under AGPL-3.0-or-later.
 */

import { modelCaps } from './models.js';
import { activeRefs, settings, slotPaths } from './settings.js';
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
 * (char → user → NPCs), capped at maxRefs. Slots named in `names` (a tag's
 * `ref_names`) are always sent, ahead of the rest. Pure apart from reading settings.
 */
export function matchRefs(promptText, { refs = activeRefs(), max = maxRefsFor(), names = [] } = {}) {
    const out = [];
    const wanted = (Array.isArray(names) ? names : [names]).map(n => String(n ?? '').trim()).filter(Boolean).join(' | ');
    const slots = [[refs.char, 'char', 'Character'], [refs.user, 'user', 'You'], ...(refs.npcs || []).map(npc => [npc, 'npc', 'NPC'])]
        .map(([slot, kind, label]) => [slot, kind, label, slotPaths(slot)])
        .filter(([, , , paths]) => paths.length)
        .map(([slot, kind, label, paths]) => {
            const slotName = slotNames(slot, kind);
            const reason = wanted && nameInText(slotName, wanted) ? 'requested'
                : slot.always ? 'always'
                    : nameInText(slotName, promptText) ? 'name' : '';
            return { slot, kind, label, slotName, reason, paths };
        });
    // Characters with several photos: everyone's first photo goes before anyone's
    // second, so a tight limit still shows every character.
    for (const pass of [['requested'], ['always', 'name']]) {
        const inPass = slots.filter(x => pass.includes(x.reason));
        const rounds = Math.max(0, ...inPass.map(x => x.paths.length));
        for (let r = 0; r < rounds; r++) {
            for (const { slot, kind, label, slotName, reason, paths } of inPass) {
                if (out.length >= max || r >= paths.length) continue;
                const name = splitAliases(slotName)[0] || label;
                out.push({
                    kind, label, name, path: paths[r], reason, layer: slot.layer || 'global',
                    photo: r + 1, photos: paths.length,
                });
            }
        }
    }
    // Keep each character's photos together, in their order.
    const order = new Map();
    for (const m of out) if (!order.has(m.name + m.kind)) order.set(m.name + m.kind, order.size);
    out.sort((a, b) => order.get(a.name + a.kind) - order.get(b.name + b.kind) || a.photo - b.photo);
    // Number the photos actually sent ("photo 2 of 2", not "of 5" when the limit cut some).
    for (const m of out) {
        const mine = out.filter(x => x.name === m.name && x.kind === m.kind);
        m.photos = mine.length;
        m.photo = mine.indexOf(m) + 1;
    }
    return out;
}

/** "Elodie", or "Elodie (photo 2 of 3)" when several of her photos are sent. */
export function refLabel(m) {
    return m.photos > 1 ? `${m.name} (photo ${m.photo} of ${m.photos})` : m.name;
}

/** Load matched references as data URLs. Missing files are skipped with a warning. */
export async function collectRefs(promptText, opts) {
    const matched = matchRefs(promptText, opts);
    const urls = [];
    const labels = [];
    for (const m of matched) {
        try {
            urls.push(await load(m.path));
            labels.push(refLabel(m));
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
