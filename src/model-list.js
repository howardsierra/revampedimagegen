/*
 * Revamped Image Gen — the models the user's key can actually use.
 *
 * Hard-coded model IDs go stale (providers rename "-preview" models, retire
 * old ones). Everything that offers or validates a model asks this module,
 * which lists the provider's models and caches the answer per connection.
 * Licensed under AGPL-3.0-or-later.
 */

import { bestModel, isImageModelId, modelCaps } from './models.js';
import { getProvider } from './providers.js';
import { save, settings } from './settings.js';
import { log, toast } from './st.js';

const TTL = 10 * 60 * 1000;
const cache = new Map(); // connection key -> { ids, error, at }

function connKey(s = settings()) {
    // Only a short fingerprint of the key, never the key itself.
    const k = String(s.apiKey || '');
    return `${s.provider}|${s.endpoint}|${s.useCorsProxy}|${k.length}:${k.slice(-4)}`;
}

/**
 * List models for the current connection.
 * @returns {Promise<{ids: string[], images: string[], error: Error|null, at: number}>}
 */
export async function listModels({ force = false } = {}) {
    const s = settings();
    const provider = getProvider(s.provider);
    const key = connKey(s);
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < TTL) return hit;
    if (!provider.listModels) return { ids: [], images: [], error: null, at: Date.now(), unsupported: true };
    let entry;
    try {
        const ids = [...new Set(await provider.listModels(s))];
        const images = ids.filter(isImageModelId).filter(id => !modelCaps(id).unsupported);
        entry = { ids, images, error: null, at: Date.now() };
    } catch (e) {
        entry = { ids: [], images: [], error: e, at: Date.now() };
    }
    cache.set(key, entry);
    return entry;
}

export function cachedModels() {
    return cache.get(connKey()) || null;
}

export function forgetModels() {
    cache.clear();
}

/** The id from `ids` that `wanted` most likely means (exact, or a -preview / dated variant). */
export function resolveId(wanted, ids) {
    if (!wanted || !ids?.length) return null;
    if (ids.includes(wanted)) return wanted;
    const w = wanted.toLowerCase();
    const bare = (x) => x.toLowerCase().replace(/^models\//, '').replace(/^[a-z0-9-]+\//, '');
    return ids.find(id => bare(id) === bare(w))
        || ids.find(id => bare(id).startsWith(bare(w)))
        || ids.find(id => bare(w).startsWith(bare(id)))
        || null;
}

/**
 * Make sure the selected model exists for this key. If it does not, switch to
 * the closest match or the best image model available, and say so.
 * Returns { changed, model, reason }.
 */
export async function ensureValidModel({ quiet = false } = {}) {
    const s = settings();
    const provider = getProvider(s.provider);
    if (!provider.listModels || (provider.keyRequired && !s.apiKey)) return { changed: false, model: s.model };
    const { ids, images, error } = await listModels();
    if (error || !ids.length) return { changed: false, model: s.model, error };
    if (s.model && ids.includes(s.model)) return { changed: false, model: s.model };
    const next = resolveId(s.model, ids) || bestModel(images);
    if (!next || next === s.model) return { changed: false, model: s.model };
    const before = s.model;
    s.model = next;
    save('model');
    const label = modelCaps(next).label || next;
    log('info', `Model "${before || '(none)'}" not available on this key; switched to ${next}`);
    if (!quiet) {
        toast.info(before
            ? `"${before}" isn't available on your key — switched to ${label} (${next}).`
            : `Selected ${label} (${next}), the best image model on your key.`, { timeOut: 7000 });
    }
    return { changed: true, model: next, from: before };
}
