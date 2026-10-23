/*
 * Revamped Image Gen — network transport, errors and retry.
 * Licensed under AGPL-3.0-or-later.
 */

import { IS_IOS, abortError, isAbort, log, sleep } from './st.js';

export class HttpError extends Error {
    constructor(status, body, url) {
        super(`HTTP ${status}${body ? `: ${summarizeBody(body)}` : ''}`);
        this.name = 'HttpError';
        this.status = status;
        this.body = body;
        this.url = url;
        this.retryAfter = null;
    }
}

/** Pull a human-readable message out of the usual provider error envelopes. */
export function summarizeBody(body) {
    const text = String(body ?? '');
    try {
        const j = JSON.parse(text);
        const msg = j?.error?.message || j?.error?.msg || (typeof j?.error === 'string' ? j.error : null)
            || j?.message || j?.detail?.message || (typeof j?.detail === 'string' ? j.detail : null) || j?.reason;
        if (msg) return String(msg).slice(0, 400);
    } catch { /* not JSON */ }
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Minimal Response look-alike built from an XHR, for the iOS transport. */
function xhrResponse(xhr) {
    const blob = xhr.response instanceof Blob ? xhr.response : new Blob([xhr.response ?? '']);
    return {
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        headers: { get: (h) => xhr.getResponseHeader(h) },
        text: () => blob.text(),
        json: async () => JSON.parse(await blob.text()),
        blob: async () => blob,
    };
}

function xhrFetch(url, opts, signal) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(opts.method || 'GET', url, true);
        xhr.responseType = 'blob';
        for (const [k, v] of Object.entries(opts.headers || {})) xhr.setRequestHeader(k, v);
        xhr.onload = () => resolve(xhrResponse(xhr));
        xhr.onerror = () => reject(new TypeError('Network error (request blocked, offline, or CORS)'));
        xhr.ontimeout = () => reject(new Error('Timed out'));
        const onAbort = () => { xhr.abort(); reject(abortError(signal.reason)); };
        if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }
        xhr.send(opts.body ?? null);
    });
}

/**
 * fetch with timeout + external abort. iOS Safari kills long fetches when the
 * tab is backgrounded; XHR survives far better there, so iOS uses XHR.
 */
export async function request(url, opts = {}, { timeoutMs = 300000, signal } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort('timeout'); }, timeoutMs);
    const relay = () => controller.abort(signal.reason);
    if (signal) {
        if (signal.aborted) relay();
        else signal.addEventListener('abort', relay, { once: true });
    }
    try {
        const useXhr = IS_IOS && !(opts.body instanceof ReadableStream);
        return useXhr
            ? await xhrFetch(url, opts, controller.signal)
            : await fetch(url, { ...opts, signal: controller.signal });
    } catch (e) {
        if (timedOut) {
            const err = new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
            err.timeout = true;
            throw err;
        }
        if (controller.signal.aborted || isAbort(e)) throw abortError(signal?.reason ?? 'Cancelled');
        if (e instanceof TypeError) {
            const err = new Error(`Network error reaching ${safeOrigin(url)} — check the URL, your connection, or enable the CORS proxy option.`);
            err.network = true;
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', relay);
    }
}

function safeOrigin(url) {
    try { return new URL(url, location.href).origin; } catch { return url; }
}

/** request() + throw HttpError on non-2xx, parse JSON. */
export async function requestJson(url, opts, transport) {
    const res = await request(url, opts, transport);
    if (!res.ok) {
        const err = new HttpError(res.status, await res.text().catch(() => ''), url);
        const ra = res.headers.get?.('retry-after');
        if (ra) err.retryAfter = Number(ra) * 1000 || (Date.parse(ra) - Date.now()) || null;
        throw err;
    }
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Provider returned non-JSON: ${summarizeBody(text) || '(empty body)'}`);
    }
}

const RETRIABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

export function isRetriable(e) {
    if (isAbort(e)) return false;
    if (e?.noRetry) return false;
    if (e instanceof HttpError) return RETRIABLE.has(e.status);
    return !!(e?.timeout || e?.network);
}

/**
 * Run `fn(attempt)` with exponential backoff + jitter on transient failures.
 * Server-sent Retry-After is honoured (capped at 60s).
 */
export async function withRetry(fn, { retries = 2, baseDelay = 1500, signal, onRetry } = {}) {
    let attempt = 0;
    while (true) {
        try {
            return await fn(attempt);
        } catch (e) {
            // A 5xx is nearly always upstream trouble: allow one retry even when retries = 0.
            const budget = (e instanceof HttpError && e.status >= 500) ? Math.max(1, retries) : retries;
            if (attempt >= budget || !isRetriable(e)) throw e;
            const backoff = baseDelay * 2 ** attempt * (0.8 + Math.random() * 0.4);
            const wait = Math.min(60000, Math.max(backoff, e.retryAfter || 0));
            attempt++;
            log('warn', `Attempt ${attempt} failed (${e.message}); retrying in ${Math.round(wait)}ms`);
            onRetry?.(attempt, wait, e);
            await sleep(wait, signal);
        }
    }
}

// ---------------------------------------------------------------- data helpers

export function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error || new Error('Could not read file'));
        r.readAsDataURL(blob);
    });
}

export function dataUrlToBlob(dataUrl) {
    const [head, b64] = String(dataUrl).split(',');
    const mime = /data:([^;]+)/.exec(head)?.[1] || 'application/octet-stream';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

/** Sniff an image MIME from base64 magic bytes (Safari rejects mislabelled data URLs). */
export function sniffMime(b64) {
    let head = '';
    try { head = atob(String(b64).slice(0, 24)); } catch { return 'image/png'; }
    const b = i => head.charCodeAt(i);
    if (b(0) === 0x89 && head.slice(1, 4) === 'PNG') return 'image/png';
    if (b(0) === 0xFF && b(1) === 0xD8) return 'image/jpeg';
    if (head.startsWith('GIF8')) return 'image/gif';
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
    if (head.slice(4, 8) === 'ftyp') return 'video/mp4';
    if (b(0) === 0x1A && b(1) === 0x45) return 'video/webm';
    return 'image/png';
}

export function toDataUrl(b64, mime) {
    const s = String(b64);
    if (s.startsWith('data:')) return s;
    return `data:${mime || sniffMime(s)};base64,${s}`;
}

export function splitDataUrl(dataUrl) {
    const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(String(dataUrl));
    if (m) return { mime: m[1], b64: m[2] };
    return { mime: sniffMime(dataUrl), b64: String(dataUrl) };
}

/** Downscale + JPEG-encode an image (used for reference photos). */
export function compressImage(src, maxDim = 1024, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
            const w = Math.max(1, Math.round(img.naturalWidth * scale));
            const h = Math.max(1, Math.round(img.naturalHeight * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const g = canvas.getContext('2d');
            g.fillStyle = '#fff';
            g.fillRect(0, 0, w, h);
            g.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('Could not decode image'));
        img.src = src;
    });
}
