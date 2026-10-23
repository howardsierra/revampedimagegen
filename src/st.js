/*
 * Revamped Image Gen — thin wrappers around SillyTavern globals, logging and
 * device detection. Licensed under AGPL-3.0-or-later.
 */

import { DISPLAY_NAME } from './constants.js';

/** Always fetch a fresh context: name1/name2/chat/characterId are snapshots. */
export function ctx() {
    return SillyTavern.getContext();
}

export const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

// ---------------------------------------------------------------- logging

const LOG_LIMIT = 800;
const logBuffer = [];
const logListeners = new Set();

const SECRET_PATTERNS = [
    /(Bearer\s+)[A-Za-z0-9._\-~+/]{8,}=*/gi,
    /(x-goog-api-key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
    /([?&](?:key|api_key|token)=)[^&\s"']+/gi,
    /\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{10,}/g,
    /\b(AIza[0-9A-Za-z_-]{4})[0-9A-Za-z_-]{20,}/g,
];

let secretsToMask = [];

/** Register live secrets (API keys) so they are masked even if they match no pattern. */
export function setSecretsToMask(values) {
    secretsToMask = values.filter(v => typeof v === 'string' && v.length >= 6);
}

export function redact(text) {
    let s = String(text);
    for (const secret of secretsToMask) s = s.split(secret).join('••••');
    for (const re of SECRET_PATTERNS) s = s.replace(re, '$1••••');
    return s;
}

export function log(level, ...args) {
    const message = redact(args.map(a => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
    }).join(' '));
    const entry = { t: Date.now(), level, message };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_LIMIT) logBuffer.shift();
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.debug;
    fn('[RIG]', message);
    for (const l of logListeners) {
        try { l(entry); } catch { /* listener errors never break logging */ }
    }
}

export function getLogs() {
    return logBuffer.slice();
}

export function onLog(fn) {
    logListeners.add(fn);
    return () => logListeners.delete(fn);
}

export function logsAsText() {
    return logBuffer.map(e => `[${new Date(e.t).toISOString()}] [${e.level.toUpperCase()}] ${e.message}`).join('\n');
}

// ---------------------------------------------------------------- toasts

export const toast = {
    info: (msg, opts) => globalThis.toastr?.info(msg, DISPLAY_NAME, { timeOut: 2500, ...opts }),
    success: (msg, opts) => globalThis.toastr?.success(msg, DISPLAY_NAME, { timeOut: 2000, ...opts }),
    warn: (msg, opts) => globalThis.toastr?.warning(msg, DISPLAY_NAME, { timeOut: 5000, ...opts }),
    error: (msg, opts) => globalThis.toastr?.error(msg, DISPLAY_NAME, { timeOut: 7000, ...opts }),
};

// ---------------------------------------------------------------- misc

export function getCharName() {
    const c = ctx();
    if (c.groupId) return '';
    return c.characters?.[c.characterId]?.name || c.name2 || '';
}

export function getUserName() {
    return ctx().name1 || '';
}

export function chatId() {
    try { return ctx().getCurrentChatId?.() || ''; } catch { return ''; }
}

/** Folder name for generated files: the character (or group) name, sanitized by the server. */
export function mediaFolder() {
    const c = ctx();
    if (c.groupId) {
        const g = c.groups?.find(x => String(x.id) === String(c.groupId));
        if (g?.name) return g.name;
    }
    return getCharName() || 'generated';
}

/** URL of a file shipped with this extension (works for any install folder name). */
export function assetUrl(file) {
    return new URL(`../${file}`, import.meta.url).pathname;
}

export function haptic(pattern) {
    try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}

export function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError(signal.reason));
        const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(t); reject(abortError(signal.reason)); };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export function abortError(reason) {
    const e = new Error(typeof reason === 'string' ? reason : 'Cancelled');
    e.name = 'AbortError';
    e.reason = reason;
    return e;
}

export function isAbort(e) {
    return e?.name === 'AbortError';
}
