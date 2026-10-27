/*
 * Revamped Image Gen — endpoint URL handling. Pure functions (unit-tested).
 * Licensed under AGPL-3.0-or-later.
 */

// Method paths people paste by accident. Version segments (/v1) are kept —
// joinUrl() avoids doubling them.
const KNOWN_SUFFIXES = [
    /\/images\/(generations|edits)$/i,
    /\/chat\/completions$/i,
    /\/v1beta\/models(\/[^?]*)?$/i,
    /\/models$/i,
    /\/api\/generate$/i,
    /\/api\/generate-image$/i,
    /\/sdapi\/v1\/[a-z0-9]+$/i,
];

/** Base URL without trailing slashes or a pasted method path (".../v1/images/generations"). */
export function normalizeBase(endpoint) {
    let s = String(endpoint || '').trim().replace(/\/+$/, '');
    for (const re of KNOWN_SUFFIXES) s = s.replace(re, '');
    return s.replace(/\/+$/, '');
}

/**
 * Join a base URL and an API path without doubling a version segment:
 * "https://x.com/api/v1" + "/v1/images/generations" → "https://x.com/api/v1/images/generations".
 * Many providers document their base as ".../v1"; users paste it that way.
 */
export function joinUrl(base, path) {
    const b = String(base || '').replace(/\/+$/, '');
    let p = String(path || '');
    if (!p.startsWith('/')) p = `/${p}`;
    const m = /\/(v\d+(?:beta|alpha)?\d*)$/i.exec(b);
    if (m) {
        const seg = `/${m[1].toLowerCase()}/`;
        if (p.toLowerCase().startsWith(seg)) p = p.slice(seg.length - 1);
        else if (p.toLowerCase() === seg.slice(0, -1)) p = '';
    }
    return `${b}${p}`;
}

/** Provider id that an endpoint clearly belongs to, or null. */
export function providerForEndpoint(endpoint) {
    let host = '';
    try { host = new URL(String(endpoint || '')).hostname.toLowerCase(); } catch { return null; }
    if (host === 'nano-gpt.com' || host.endsWith('.nano-gpt.com')) return 'nanogpt';
    if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
    if (host.endsWith('generativelanguage.googleapis.com')) return 'gemini';
    if (host === 'naistera.org') return 'naistera';
    return null;
}
