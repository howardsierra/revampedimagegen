/*
 * Revamped Image Gen — generation pipeline: resolve options → collect refs →
 * call provider with retry → persist on the ST server.
 * Licensed under AGPL-3.0-or-later.
 */

import { ASPECT_RATIOS, IMAGE_SIZES, VIDEO_RESOLUTIONS } from './constants.js';
import { withRetry } from './net.js';
import { clampSize, learnModelSizes, modelCaps, parseSupportedSizes, sizeFor } from './models.js';
import { autoProvider, ensureValidModel } from './model-list.js';
import { generateVideo, getProvider } from './providers.js';
import { collectRefs } from './refs.js';
import { save, settings } from './settings.js';
import { log } from './st.js';
import { persistResult } from './storage.js';

/**
 * Merge instruction data (from a tag or the studio form) with user defaults.
 * Aspect ratio always follows the instruction when valid: it is a composition
 * choice. Other fields follow the instruction only when `tagOverrides` is on
 * (or the request came from the studio, where the user typed them).
 */
export function resolveOptions(kind, data, { fromStudio = false } = {}) {
    const s = settings();
    const tagWins = fromStudio || s.tagOverrides;
    const pick = (tagVal, def) => (tagWins ? (tagVal || def) : (def || tagVal));
    const ar = ASPECT_RATIOS.includes(data.aspect_ratio) ? data.aspect_ratio : (kind === 'video' ? '16:9' : s.aspectRatio);
    // "Auto" (or anything the model cannot make) resolves to the model's own default.
    const norm = (v) => { const u = String(v || '').toUpperCase(); return u === 'AUTO' ? 'auto' : (IMAGE_SIZES.includes(u) || u === '512' ? u : ''); };
    const imageSize = sizeFor(s.model, pick(norm(data.image_size), norm(s.imageSize) || 'auto') || 'auto');
    const raw = String(data.prompt || '').trim();
    // `style: false` / "none" skips the default style for this request.
    const noStyle = data.style === false || /^\s*(none|off)\s*$/i.test(String(data.style ?? ''));
    const prompt = fromStudio ? raw : [s.promptPrefix, raw, s.promptSuffix].map(x => String(x || '').trim()).filter(Boolean).join(' ');
    return {
        kind,
        rawPrompt: raw,
        prompt,
        style: noStyle ? '' : (pick(data.style, s.defaultStyle) || ''),
        aspectRatio: ar,
        imageSize,
        quality: pick(data.quality, s.quality),
        preset: data.preset || '',
        negative: data.negative_prompt || s.negativePrompt || '',
        seed: Number.isFinite(Number(data.seed)) && data.seed !== '' && data.seed != null ? Number(data.seed) : null,
        duration: data.duration,
        resolution: VIDEO_RESOLUTIONS.includes(data.resolution) ? data.resolution : undefined,
        audio: typeof data.audio === 'boolean' ? data.audio : undefined,
        refMode: data.ref_mode,
        noRefs: !!data.no_refs && data.no_refs !== 'false',
        refNames: parseRefNames(data.ref_names),
    };
}

/** `ref_names` as an array: accepts ["Ciara", "Mina"] or "Ciara, Mina". */
export function parseRefNames(v) {
    const list = Array.isArray(v) ? v : String(v ?? '').split(/[,;]/);
    return list.map(n => String(n ?? '').trim()).filter(Boolean);
}

/** Throw a friendly, non-retriable error if the connection is obviously incomplete. */
export function validateConnection(kind = 'image') {
    const s = settings();
    const p = getProvider(s.provider);
    const fail = (msg) => { throw Object.assign(new Error(msg), { noRetry: true, config: true }); };
    if (!s.endpoint && !p.defaultEndpoint) fail('Set an endpoint URL in Settings → Connection.');
    if (p.keyRequired && !s.apiKey) fail(`${p.label} needs an API key (Settings → Connection).`);
    if (p.supportsModels && p.keyRequired && !s.model && kind === 'image') fail('Pick a model in Settings → Connection.');
    if (kind === 'video' && !s.videoModel) fail('Set a video model in Settings → Video.');
}

/**
 * Generate one image/video and save it. Returns
 * { path, persisted, options, refNames, provider, model, ms }.
 */
export async function generate(kind, data, { signal, setStatus = () => {}, fromStudio = false } = {}) {
    if (autoProvider() && kind === 'image') await ensureValidModel();
    validateConnection(kind);
    const s = settings();
    const provider = getProvider(s.provider);
    const opts = resolveOptions(kind, data, { fromStudio });
    if (!opts.rawPrompt) throw Object.assign(new Error('Empty prompt'), { noRetry: true });

    let refs = [];
    let refNames = [];
    let refLabels = [];
    const canRef = kind === 'video' || (provider.supportsRefs && s.sendRefs);
    if (canRef && !opts.noRefs) {
        setStatus('Loading references…');
        const r = await collectRefs(opts.rawPrompt, { names: opts.refNames, ...(kind === 'video' ? { max: 4 } : {}) });
        refs = r.urls;
        refLabels = r.labels;
        refNames = r.matched.map(m => m.name);
    }

    const req = { ...opts, refs, refLabels, signal, timeoutMs: (Number(s.timeoutSec) || 300) * 1000 * (kind === 'video' ? 2 : 1) };
    const t0 = Date.now();
    setStatus(kind === 'video' ? 'Rendering video…' : 'Generating…');
    log('info', `${provider.label}: ${kind} "${opts.prompt.slice(0, 60)}" ar=${opts.aspectRatio} size=${opts.imageSize} refs=${refs.length}`);

    const attempt = () => withRetry(
        () => (kind === 'video' ? generateVideo(req, s) : provider.generate(req, s)),
        {
            retries: Number(s.maxRetries) || 0,
            baseDelay: Number(s.retryDelay) || 1500,
            signal,
            onRetry: (n, wait, e) => setStatus(`${shortError(e)} — retry ${n} in ${Math.ceil(wait / 1000)}s`),
        },
    );
    let result;
    try {
        result = await attempt();
    } catch (e) {
        if (kind !== 'image') throw e;
        // "X supports 1K or 2K resolution": remember that for this model and retry at the closest allowed size.
        const sizes = e?.status === 400 ? parseSupportedSizes(`${e.body || ''} ${e.message || ''}`) : null;
        if (sizes) {
            const next = clampSize(req.imageSize, sizes);
            learnSizes(s.model, sizes);
            if (next === req.imageSize) throw e;
            log('warn', `${s.model} only supports ${sizes.join('/')}; retrying at ${next}`);
            setStatus(`Retrying at ${next}…`);
            req.imageSize = next;
            opts.imageSize = next;
            result = await attempt();
        } else {
            // "Model not found" usually means the id is stale or not on this key.
            // Switch to the matching model the key does have and try once more.
            if (!isModelNotFound(e)) throw e;
            setStatus('Model not found — checking your models…');
            const fixed = await ensureValidModel();
            if (!fixed.changed) throw e;
            setStatus(`Retrying with ${fixed.model}…`);
            result = await attempt();
        }
    }

    setStatus('Saving…');
    const saved = await persistResult(result, { useCorsProxy: s.useCorsProxy, signal });
    return { ...saved, options: opts, refNames, provider: provider.id, model: kind === 'video' ? s.videoModel : s.model, ms: Date.now() - t0 };
}

/** Persist the sizes a provider says a model takes, so the size chips and "Auto" follow it. */
function learnSizes(model, sizes) {
    const s = settings();
    const known = modelCaps(model).sizes || [];
    if (known.join() === sizes.join()) return;
    s.learnedSizes = { ...(s.learnedSizes || {}), [model]: sizes };
    learnModelSizes({ [model]: sizes });
    save('learnedSizes');
}

export function isModelNotFound(e) {
    const st = e?.status;
    const body = String(e?.body || e?.message || '');
    if (st !== 404 && st !== 400) return false;
    return /model/i.test(body) && /not (found|exist|available|support)|unknown model|invalid (image )?model|does not exist|no such model|is not found/i.test(body);
}

export function shortError(e) {
    const m = String(e?.message || e || 'Error');
    return m.length > 60 ? `${m.slice(0, 57)}…` : m;
}

/** Suggest a fix for common failures. Returns a sentence or ''. */
export function hintFor(e) {
    const s = settings();
    const msg = String(e?.message || '').toLowerCase();
    const status = e?.status;
    if (status === 401 || status === 403 || /unauthor|invalid api key|permission/.test(msg)) return 'The provider rejected your key. Re-check the API key, and that this key can use the selected model.';
    if (isModelNotFound(e)) return 'That model is not available on your key. Tap the model in Settings → Connection to choose one from your account.';
    if (status === 404) return s.provider === 'openai'
        ? 'Path not found. If your provider documents a prefix (like /v1 or /compatible), include it in the endpoint, or try the Gemini-compatible type.'
        : 'Path not found. Check the endpoint URL and the model name — or run Diagnose.';
    if (status === 413) return 'Request too large — try fewer reference images.';
    if (status === 429) return 'Rate limited. Lower "Parallel jobs" in Settings → Behaviour.';
    if (/cors|network error/.test(msg)) return 'The browser could not reach the provider. Enable "Route through ST CORS proxy" (needs enableCorsProxy: true in config.yaml).';
    if (/safety|blocked/.test(msg)) return 'The provider\'s safety filter blocked this prompt. Rephrase it or use a different model.';
    if (/text instead of an image/.test(msg)) return 'This model answered with text. Pick an image-capable model.';
    if (/timed out/.test(msg)) return 'The provider took too long. Raise the timeout in Settings → Behaviour.';
    return '';
}
