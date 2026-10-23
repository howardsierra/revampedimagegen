/*
 * Revamped Image Gen — manual ("studio") generation from the panel.
 * Results are kept per chat in chat metadata so they survive reloads.
 * Licensed under AGPL-3.0-or-later.
 */

import { generate } from './engine.js';
import * as queue from './queue.js';
import { settings } from './settings.js';
import { chatId, ctx, haptic } from './st.js';

const HISTORY_MAX = 150;
let memoryHistory = [];
const listeners = new Set();

export function onStudioChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit() {
    for (const fn of listeners) fn();
}

/** Studio results for the open chat, newest first. */
export function studioHistory() {
    const meta = ctx().chatMetadata;
    if (chatId() && meta) return Array.isArray(meta.iig_studio) ? meta.iig_studio : [];
    return memoryHistory;
}

function persist(list) {
    const c = ctx();
    if (chatId() && c.chatMetadata) {
        c.chatMetadata.iig_studio = list;
        if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c.saveMetadata?.();
    } else {
        memoryHistory = list;
    }
    emit();
}

export function addToHistory(item) {
    const list = [item, ...studioHistory().filter(x => x.src !== item.src)].slice(0, HISTORY_MAX);
    persist(list);
}

export function removeFromHistory(src) {
    persist(studioHistory().filter(x => x.src !== src));
}

/**
 * Queue `count` generations from studio input. Each finished image is added to
 * the studio history of the chat that was open when it was queued.
 */
export function runStudio({ kind = 'image', data, count = 1 }) {
    const jobs = [];
    const forChat = chatId();
    for (let i = 0; i < Math.max(1, Math.min(8, count)); i++) {
        // Distinct seeds so a batch gives variations instead of duplicates.
        const d = { ...data };
        if (count > 1 && d.seed == null) d.seed = Math.floor(Math.random() * 2 ** 31);
        jobs.push(queue.enqueue({
            kind,
            prompt: d.prompt,
            meta: { source: 'studio', chatId: forChat, aspectRatio: d.aspect_ratio || settings().aspectRatio },
        }, async (job, signal, setStatus) => {
            const res = await generate(kind, d, { signal, setStatus, fromStudio: true });
            const item = {
                src: res.path,
                kind,
                prompt: d.prompt,
                data: { ...d, aspect_ratio: res.options.aspectRatio, style: res.options.style || undefined },
                t: Date.now(),
                model: res.model,
                provider: res.provider,
                refs: res.refNames,
                source: 'studio',
            };
            if (forChat === chatId()) addToHistory(item);
            if (settings().haptics) haptic(25);
            return item;
        }));
    }
    return jobs;
}
