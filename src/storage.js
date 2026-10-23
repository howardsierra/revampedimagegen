/*
 * Revamped Image Gen — saving media on the SillyTavern server.
 * Licensed under AGPL-3.0-or-later.
 */

import { REFS_FOLDER } from './constants.js';
import { request, blobToDataUrl, splitDataUrl } from './net.js';
import { ctx, log, mediaFolder } from './st.js';

const EXT_BY_MIME = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/bmp': 'bmp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

function stamp() {
    return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
}

/** Upload a data URL via /api/images/upload; returns the client-relative path. */
export async function uploadDataUrl(dataUrl, { folder = mediaFolder(), name } = {}) {
    const { mime, b64 } = splitDataUrl(dataUrl);
    const format = EXT_BY_MIME[mime.toLowerCase()] || 'png';
    const filename = name || `iig_${stamp()}_${Math.random().toString(36).slice(2, 6)}`;
    const res = await request('/api/images/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ image: b64, format, ch_name: folder, filename }),
    }, { timeoutMs: 120000 });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Saving to SillyTavern failed (${res.status}) ${text.slice(0, 120)}`);
    }
    const { path } = await res.json();
    log('info', `Saved ${path}`);
    return path;
}

/**
 * Turn a provider result ({dataUrl} | {url}) into a data URL. Remote URLs are
 * fetched directly, then through ST's CORS proxy if that is enabled.
 */
export async function resultToDataUrl(result, { useCorsProxy = false, signal } = {}) {
    if (result.dataUrl) return result.dataUrl;
    const tries = [result.url];
    if (useCorsProxy && /^https?:/i.test(result.url)) tries.push(`/proxy/${result.url}`);
    let lastErr;
    for (const url of tries) {
        try {
            const res = await request(url, {}, { timeoutMs: 120000, signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await blobToDataUrl(await res.blob());
        } catch (e) {
            lastErr = e;
        }
    }
    throw Object.assign(new Error(`Could not download the result (${lastErr?.message}). Enable the CORS proxy option or use base64 output.`), { remoteUrl: result.url });
}

/** Save any provider result; falls back to embedding the remote URL if it cannot be downloaded. */
export async function persistResult(result, opts = {}) {
    try {
        const dataUrl = await resultToDataUrl(result, opts);
        return { path: await uploadDataUrl(dataUrl, opts), persisted: true };
    } catch (e) {
        if (e.remoteUrl) {
            log('warn', `Using remote URL directly: ${e.message}`);
            return { path: e.remoteUrl, persisted: false };
        }
        throw e;
    }
}

export async function uploadRef(dataUrl, slug) {
    const safe = String(slug || 'ref').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'ref';
    return uploadDataUrl(dataUrl, { folder: REFS_FOLDER, name: `iig_ref_${safe}_${Date.now().toString(36)}` });
}

/** Delete a file we created. Refuses anything outside /user/images/. Never throws. */
export async function deleteFile(path) {
    const rel = String(path || '').replace(/^\/+/, '');
    if (!rel.startsWith('user/images/')) {
        log('warn', `Refusing to delete ${path}`);
        return false;
    }
    try {
        const res = await request('/api/images/delete', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ path: rel }),
        }, { timeoutMs: 15000 });
        return res.ok || res.status === 404;
    } catch (e) {
        log('warn', `Delete failed for ${path}: ${e.message}`);
        return false;
    }
}

export async function loadAsDataUrl(path) {
    const res = await request(path, {}, { timeoutMs: 60000 });
    if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
    return blobToDataUrl(await res.blob());
}
