/*
 * Revamped Image Gen — image/video providers.
 *
 * Request shapes for the OpenAI-compatible, Gemini-compatible and Naistera
 * protocols follow notsosillynotsoimages by aceeenvw (AGPL-3.0-or-later).
 * OpenRouter, Stable Diffusion WebUI and Pollinations are additions.
 *
 * Every provider's generate() receives a normalized request:
 *   { prompt, style, negative, aspectRatio, imageSize, quality, preset, seed,
 *     refs: [dataUrl], signal, timeoutMs }
 * and resolves to { dataUrl } or { url }.
 */

import { REF_INSTRUCTION } from './constants.js';
import { HttpError, request, requestJson, blobToDataUrl, dataUrlToBlob, splitDataUrl, summarizeBody } from './net.js';
import { log } from './st.js';

// ---------------------------------------------------------------- helpers

const KNOWN_SUFFIXES = [
    /\/v1\/images\/(generations|edits)$/i,
    /\/v1\/chat\/completions$/i,
    /\/v1beta\/models(\/[^?]*)?$/i,
    /\/v1\/models$/i,
    /\/api\/generate$/i,
    /\/sdapi\/v1\/[a-z0-9]+$/i,
];

export function normalizeBase(endpoint) {
    let s = String(endpoint || '').trim().replace(/\/+$/, '');
    for (const re of KNOWN_SUFFIXES) s = s.replace(re, '');
    return s.replace(/\/+$/, '');
}

function base(s, provider) {
    return normalizeBase(s.endpoint) || provider.defaultEndpoint || '';
}

/** Full URL for `suffix` under the configured base, honouring path override and the ST CORS proxy. */
export function apiUrl(s, provider, suffix, { model = '', allowOverride = true } = {}) {
    const b = base(s, provider);
    if (!b) throw Object.assign(new Error('No endpoint URL configured'), { noRetry: true });
    let path = allowOverride && s.pathOverride?.trim() ? s.pathOverride.trim() : suffix;
    if (!path.startsWith('/')) path = `/${path}`;
    path = path.replace('{model}', encodeURIComponent(model));
    const url = `${b}${path}`;
    return s.useCorsProxy && /^https?:/i.test(url) ? `/proxy/${url}` : url;
}

function bearer(s) {
    return s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {};
}

function isGoogleHost(url) {
    try { return new URL(url.replace(/^\/proxy\//, ''), location.href).hostname.endsWith('googleapis.com'); } catch { return false; }
}

export function composePrompt(req, { styleMode = 'bracket' } = {}) {
    let p = req.prompt;
    if (req.style) p = styleMode === 'comma' ? `${req.style}, ${p}` : `[Style: ${req.style}] ${p}`;
    if (req.refs?.length) p = `${REF_INSTRUCTION}\n\n${p}`;
    return p;
}

const RATIO = (ar) => {
    const [w, h] = String(ar || '1:1').split(':').map(Number);
    return w > 0 && h > 0 ? w / h : 1;
};

/** Width/height for free-size backends: long side from image size, snapped to multiples of 64. */
export function dimsFor(ar, imageSize = '1K', longSide = null) {
    const long = longSide || ({ '1K': 1024, '2K': 2048, '4K': 4096 }[imageSize] || 1024);
    const r = RATIO(ar);
    const snap = v => Math.max(64, Math.round(v / 64) * 64);
    return r >= 1 ? { width: snap(long), height: snap(long / r) } : { width: snap(long * r), height: snap(long) };
}

function orientation(ar) {
    const r = RATIO(ar);
    if (r > 1.1) return 'landscape';
    if (r < 0.9) return 'portrait';
    return 'square';
}

async function urlOrBlobResult(res) {
    const blob = await res.blob();
    if (!blob.size) throw new Error('Provider returned an empty image');
    if (blob.type && !/^image\//.test(blob.type)) {
        throw new Error(`Provider returned ${blob.type}: ${summarizeBody(await blob.text())}`);
    }
    return { dataUrl: await blobToDataUrl(blob) };
}

// ---------------------------------------------------------------- OpenAI-compatible

const OPENAI_FALLBACK_SIZES = {
    '1:1': '1024x1024', '16:9': '1792x1024', '21:9': '1792x1024', '3:2': '1536x1024', '4:3': '1344x1024',
    '5:4': '1280x1024', '9:16': '1024x1792', '2:3': '1024x1536', '3:4': '1024x1344', '4:5': '1024x1280',
};

function openaiSizeAndQuality(model, req, s) {
    const m = String(model).toLowerCase();
    const o = orientation(req.aspectRatio);
    const big = req.imageSize === '2K' || req.imageSize === '4K';
    if (/gpt-image/.test(m)) {
        const size = { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' }[o];
        let quality = req.quality && req.quality !== 'auto' ? req.quality : (big ? 'high' : 'auto');
        quality = { standard: 'medium', hd: 'high' }[quality] || quality;
        if (!['low', 'medium', 'high', 'auto'].includes(quality)) quality = 'auto';
        return { size, quality };
    }
    if (/dall-e-3/.test(m)) {
        const size = { square: '1024x1024', landscape: '1792x1024', portrait: '1024x1792' }[o];
        return { size, quality: big || req.quality === 'hd' || req.quality === 'high' ? 'hd' : 'standard', b64: true };
    }
    if (/dall-e-2/.test(m)) return { size: '1024x1024', b64: true };
    return { size: OPENAI_FALLBACK_SIZES[req.aspectRatio] || '1024x1024', quality: req.quality && req.quality !== 'auto' ? req.quality : undefined };
}

function parseOpenAiImage(json) {
    const d = json?.data?.[0];
    if (d?.b64_json) return { dataUrl: `data:image/png;base64,${d.b64_json}` };
    if (d?.url) return { url: d.url };
    if (json?.url) return { url: json.url };
    if (json?.error) throw new Error(`Provider error: ${json.error.message || JSON.stringify(json.error)}`);
    throw new Error('No image in provider response');
}

const openai = {
    id: 'openai',
    label: 'OpenAI-compatible',
    hint: 'POST /v1/images/generations. Works with OpenAI and most aggregators (gpt-image, dall-e, flux…).',
    defaultEndpoint: 'https://api.openai.com',
    keyRequired: true,
    supportsRefs: true,
    supportsModels: true,
    supportsVideo: true,

    async listModels(s) {
        const json = await requestJson(apiUrl(s, this, '/v1/models', { allowOverride: false }), { headers: bearer(s) }, { timeoutMs: 30000 });
        return (json.data || json.models || []).map(m => m.id || m.name).filter(Boolean);
    },

    async generate(req, s) {
        const { size, quality, b64 } = openaiSizeAndQuality(s.model, req, s);
        const prompt = composePrompt(req);
        const hasRefs = req.refs.length > 0;
        const native = /api\.openai\.com/i.test(base(s, this));
        const mode = s.openaiRefMode === 'auto' ? (native ? 'multipart' : 'json') : s.openaiRefMode;
        const transport = { timeoutMs: req.timeoutMs, signal: req.signal };

        if (hasRefs && mode === 'multipart') {
            const form = new FormData();
            form.append('model', s.model);
            form.append('prompt', prompt);
            form.append('n', '1');
            form.append('size', size);
            if (quality) form.append('quality', quality);
            req.refs.forEach((ref, i) => {
                const blob = dataUrlToBlob(ref);
                form.append('image[]', blob, `ref${i}.${blob.type.split('/')[1] || 'png'}`);
            });
            const json = await requestJson(apiUrl(s, this, '/v1/images/edits'), { method: 'POST', headers: bearer(s), body: form }, transport);
            return parseOpenAiImage(json);
        }

        const body = { model: s.model, prompt, n: 1, size };
        if (quality) body.quality = quality;
        if (b64) body.response_format = 'b64_json';
        if (req.negative) body.negative_prompt = req.negative;
        if (req.seed != null) body.seed = req.seed;
        if (hasRefs) body.image = req.refs.length === 1 ? req.refs[0] : req.refs;
        const suffix = hasRefs && /gpt-image-2/i.test(s.model) ? '/v1/images/edits' : '/v1/images/generations';
        const json = await requestJson(apiUrl(s, this, suffix), {
            method: 'POST',
            headers: { ...bearer(s), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, transport);
        return parseOpenAiImage(json);
    },
};

// ---------------------------------------------------------------- Gemini-compatible

function geminiHeaders(s, url) {
    // Google's own API takes the key in x-goog-api-key; proxies/aggregators speak Bearer.
    return isGoogleHost(url)
        ? { 'x-goog-api-key': s.apiKey, 'Content-Type': 'application/json' }
        : { ...bearer(s), 'Content-Type': 'application/json' };
}

function isEmptyEnvelope(r) {
    if (!r || typeof r !== 'object' || r.error || r.promptFeedback) return false;
    if (Array.isArray(r.candidates) && r.candidates.length) return false;
    const um = r.usageMetadata || r.usage_metadata;
    return !!(um && (um.promptTokenCount === 0 || um.prompt_token_count === 0)) && r.candidates == null;
}

function parseGemini(result) {
    const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
    for (const part of candidates[0]?.content?.parts || []) {
        const inline = part.inlineData || part.inline_data;
        if (inline?.data) return { dataUrl: `data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}` };
    }
    const d0 = result?.data?.[0];
    if (d0?.b64_json) return { dataUrl: `data:image/png;base64,${d0.b64_json}` };
    if (d0?.url) return { url: d0.url };
    if (result?.error) throw new Error(`Provider error: ${result.error.message || result.error.status || 'unknown'}`);
    const pf = result?.promptFeedback || result?.prompt_feedback;
    if (pf?.blockReason || pf?.block_reason) {
        throw Object.assign(new Error(`Blocked by safety filter: ${pf.blockReason || pf.block_reason}`), { noRetry: true });
    }
    const fr = candidates[0]?.finishReason || candidates[0]?.finish_reason;
    if (fr && /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/i.test(fr)) {
        throw Object.assign(new Error(`Blocked by safety filter: ${fr}`), { noRetry: true });
    }
    const text = candidates[0]?.content?.parts?.map(p => p.text).filter(Boolean).join(' ');
    if (text) throw new Error(`Model replied with text instead of an image: "${text.slice(0, 160)}"`);
    if (fr) throw new Error(`Generation stopped without an image (${fr})`);
    throw new Error('No image in Gemini response');
}

const gemini = {
    id: 'gemini',
    label: 'Gemini-compatible',
    hint: 'POST /v1beta/models/{model}:generateContent. Google AI Studio, Nano Banana, Imagen proxies.',
    defaultEndpoint: 'https://generativelanguage.googleapis.com',
    keyRequired: true,
    supportsRefs: true,
    supportsModels: true,
    supportsVideo: true,

    async listModels(s) {
        const candidates = isGoogleHost(base(s, this))
            ? ['/v1beta/models?pageSize=1000']
            : ['/v1/models', '/v1beta/models'];
        let lastErr;
        for (const suffix of candidates) {
            const url = apiUrl(s, this, suffix, { allowOverride: false });
            try {
                const json = await requestJson(url, { headers: geminiHeaders(s, url) }, { timeoutMs: 30000 });
                const list = (json.data || json.models || []).map(m => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
                if (list.length) return list;
            } catch (e) { lastErr = e; }
        }
        if (lastErr) throw lastErr;
        return [];
    },

    async generate(req, s) {
        const url = apiUrl(s, this, '/v1beta/models/{model}:generateContent', { model: s.model });
        const headers = geminiHeaders(s, url);
        const transport = { timeoutMs: req.timeoutMs, signal: req.signal };
        const imageSize = ['1K', '2K', '4K'].includes(req.imageSize) ? req.imageSize : '1K';

        const send = async (refs, withImageConfig) => {
            const parts = refs.map(r => {
                const { mime, b64 } = splitDataUrl(r);
                return { inlineData: { mimeType: mime, data: b64 } };
            });
            parts.push({ text: composePrompt({ ...req, refs }) });
            const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
            if (withImageConfig) generationConfig.imageConfig = { aspectRatio: req.aspectRatio, imageSize };
            return requestJson(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
            }, transport);
        };

        const withConfig = !/gpt-image/i.test(s.model);
        let result = await send(req.refs, withConfig);
        // Some routers silently reject (empty envelope, 0 tokens). Retry once stripped down.
        if (isEmptyEnvelope(result) && (withConfig || req.refs.length)) {
            log('warn', 'Gemini empty envelope; retrying without imageConfig/references');
            result = await send([], false);
            if (isEmptyEnvelope(result)) throw new Error('Provider returned an empty response even without references — check model access on your account.');
        }
        return parseGemini(result);
    },
};

// ---------------------------------------------------------------- OpenRouter-style chat completions

const openrouter = {
    id: 'openrouter',
    label: 'OpenRouter (chat → image)',
    hint: 'POST /v1/chat/completions with modalities ["image","text"]. OpenRouter and compatible routers.',
    defaultEndpoint: 'https://openrouter.ai/api',
    keyRequired: true,
    supportsRefs: true,
    supportsModels: true,
    supportsVideo: false,

    async listModels(s) {
        const json = await requestJson(apiUrl(s, this, '/v1/models', { allowOverride: false }), { headers: bearer(s) }, { timeoutMs: 30000 });
        const all = json.data || [];
        const imageCapable = all.filter(m => (m.architecture?.output_modalities || []).includes('image'));
        return (imageCapable.length ? imageCapable : all).map(m => m.id).filter(Boolean);
    },

    async generate(req, s) {
        const content = req.refs.map(url => ({ type: 'image_url', image_url: { url } }));
        content.push({ type: 'text', text: `${composePrompt(req)}\n\nAspect ratio: ${req.aspectRatio}.` });
        const json = await requestJson(apiUrl(s, this, '/v1/chat/completions'), {
            method: 'POST',
            headers: { ...bearer(s), 'Content-Type': 'application/json', 'X-Title': 'Revamped Image Gen' },
            body: JSON.stringify({
                model: s.model,
                messages: [{ role: 'user', content }],
                modalities: ['image', 'text'],
                image_config: { aspect_ratio: req.aspectRatio },
            }),
        }, { timeoutMs: req.timeoutMs, signal: req.signal });
        if (json.error) throw new Error(`Provider error: ${json.error.message || JSON.stringify(json.error)}`);
        const msg = json.choices?.[0]?.message || {};
        const img = msg.images?.[0];
        const url = img?.image_url?.url || img?.url;
        if (url) return url.startsWith('data:') ? { dataUrl: url } : { url };
        const text = typeof msg.content === 'string' ? msg.content : '';
        const md = /!\[[^\]]*\]\(([^)\s]+)\)/.exec(text) || /(data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+)/.exec(text);
        if (md) return md[1].startsWith('data:') ? { dataUrl: md[1] } : { url: md[1] };
        throw new Error(text ? `Model replied with text instead of an image: "${text.slice(0, 160)}"` : 'No image in response — is this model image-capable?');
    },
};

// ---------------------------------------------------------------- Naistera

const NAISTERA_MODELS = ['grok', 'nano banana 2', 'novelai'];

export function normalizeNaisteraModel(m) {
    const raw = String(m || '').trim().toLowerCase().replace(/-/g, ' ');
    if (/^nano banana/.test(raw)) return 'nano banana 2';
    if (raw === 'novel ai') return 'novelai';
    return NAISTERA_MODELS.includes(raw) ? raw : 'grok';
}

const naistera = {
    id: 'naistera',
    label: 'Naistera',
    hint: 'POST /api/generate. Grok, Nano Banana 2 or NovelAI upstreams.',
    defaultEndpoint: 'https://naistera.org',
    keyRequired: true,
    supportsRefs: true,
    supportsModels: false,
    supportsVideo: false,
    models: NAISTERA_MODELS,

    async generate(req, s) {
        const model = normalizeNaisteraModel(s.naisteraModel);
        const refs = model === 'novelai' ? [] : req.refs;
        const url = apiUrl(s, this, '/api/generate', { allowOverride: false });
        const send = (r) => {
            const body = { prompt: composePrompt({ ...req, refs: r }), aspect_ratio: req.aspectRatio, model };
            const preset = req.preset || s.naisteraPreset;
            if (preset && model === 'grok') body.preset = preset;
            if (r.length) body.reference_images = r.slice(0, 4);
            return requestJson(url, {
                method: 'POST',
                headers: { ...bearer(s), 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }, { timeoutMs: req.timeoutMs, signal: req.signal });
        };
        let json;
        try {
            json = await send(refs);
        } catch (e) {
            // Grok's reference support comes and goes; fall back to text-only once.
            if (e instanceof HttpError && refs.length && /grok_refs_temporarily_unavailable/.test(e.body || '')) {
                log('warn', 'Naistera: Grok refs unavailable, retrying without references');
                json = await send([]);
            } else throw e;
        }
        if (!json?.data_url) throw new Error('No data_url in Naistera response');
        return { dataUrl: json.data_url };
    },
};

// ---------------------------------------------------------------- Stable Diffusion WebUI (A1111 / Forge)

const sdwebui = {
    id: 'sdwebui',
    label: 'SD WebUI (A1111 / Forge)',
    hint: 'POST /sdapi/v1/txt2img on your local WebUI. Launch it with --api (and --cors-allow-origins, or enable the CORS proxy option).',
    defaultEndpoint: 'http://127.0.0.1:7860',
    keyRequired: false,
    supportsRefs: false,
    supportsNegative: true,
    supportsModels: true,
    supportsVideo: false,

    async listModels(s) {
        const json = await requestJson(apiUrl(s, this, '/sdapi/v1/sd-models', { allowOverride: false }), { headers: bearer(s) }, { timeoutMs: 30000 });
        return (Array.isArray(json) ? json : []).map(m => m.title || m.model_name).filter(Boolean);
    },

    async generate(req, s) {
        const { width, height } = dimsFor(req.aspectRatio, req.imageSize, { '1K': 1024, '2K': 1536, '4K': 2048 }[req.imageSize]);
        const body = {
            prompt: composePrompt({ ...req, refs: [] }, { styleMode: 'comma' }),
            negative_prompt: req.negative || '',
            width,
            height,
            steps: Number(s.sdSteps) || 28,
            cfg_scale: Number(s.sdCfg) || 6,
            sampler_name: s.sdSampler || 'Euler a',
            seed: req.seed ?? -1,
            n_iter: 1,
            batch_size: 1,
        };
        if (s.model) body.override_settings = { sd_model_checkpoint: s.model };
        const json = await requestJson(apiUrl(s, this, '/sdapi/v1/txt2img'), {
            method: 'POST',
            headers: { ...bearer(s), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, { timeoutMs: req.timeoutMs, signal: req.signal });
        const b64 = json?.images?.[0];
        if (!b64) throw new Error('No image in WebUI response');
        return { dataUrl: b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}` };
    },
};

// ---------------------------------------------------------------- Pollinations

const pollinations = {
    id: 'pollinations',
    label: 'Pollinations',
    hint: 'GET /prompt/{prompt}. Keyless on the free tier — handy for trying things out.',
    defaultEndpoint: 'https://image.pollinations.ai',
    keyRequired: false,
    supportsRefs: false,
    supportsNegative: false,
    supportsModels: true,
    supportsVideo: false,

    async listModels(s) {
        const json = await requestJson(apiUrl(s, this, '/models', { allowOverride: false }), { headers: bearer(s) }, { timeoutMs: 30000 });
        return (Array.isArray(json) ? json : []).map(m => (typeof m === 'string' ? m : m.name)).filter(Boolean);
    },

    async generate(req, s) {
        const { width, height } = dimsFor(req.aspectRatio, req.imageSize, 1024);
        const params = new URLSearchParams({ width, height, nologo: 'true', private: 'true' });
        if (s.model) params.set('model', s.model);
        params.set('seed', String(req.seed ?? Math.floor(Math.random() * 2 ** 31)));
        const prompt = composePrompt({ ...req, refs: [] }, { styleMode: 'comma' });
        const url = apiUrl(s, this, `/prompt/${encodeURIComponent(prompt)}?${params}`, { allowOverride: false });
        const res = await request(url, { headers: bearer(s) }, { timeoutMs: req.timeoutMs, signal: req.signal });
        if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''), url);
        return urlOrBlobResult(res);
    },
};

export const PROVIDERS = Object.freeze({ openai, gemini, openrouter, naistera, sdwebui, pollinations });

export function getProvider(id) {
    return PROVIDERS[id] || openai;
}

// ---------------------------------------------------------------- video

/**
 * Text/image-to-video via the aggregator-style /v1/video/generations route
 * (synchronous; the connection stays open while the clip renders).
 */
export async function generateVideo(req, s) {
    const model = String(s.videoModel || '').trim();
    if (!model) throw Object.assign(new Error('No video model set (Settings → Video).'), { noRetry: true });
    const provider = getProvider(s.provider);
    if (!provider.supportsVideo) throw Object.assign(new Error(`${provider.label} does not support video.`), { noRetry: true });
    const b = base(s, provider).replace(/\/compatible$/i, '').replace(/\/v1(beta)?$/i, '');
    let url = `${b}/v1/video/generations`;
    if (s.useCorsProxy && /^https?:/i.test(url)) url = `/proxy/${url}`;

    const body = {
        model,
        prompt: req.prompt,
        duration: Number(req.duration) > 0 ? Number(req.duration) : Number(s.videoDuration) || 4,
        resolution: req.resolution || s.videoResolution || '480p',
        aspect_ratio: req.aspectRatio || '16:9',
        audio: typeof req.audio === 'boolean' ? req.audio : !!s.videoAudio,
        n: 1,
    };
    if (req.negative) body.negative_prompt = req.negative;
    if (req.refs.length) {
        if (String(req.refMode).toLowerCase() === 'first_frame') {
            body.input_image = req.refs[0];
            if (req.refs.length > 1) body.reference_images = req.refs.slice(1, 4);
        } else {
            body.reference_images = req.refs.slice(0, 4);
        }
    }
    const json = await requestJson(url, {
        method: 'POST',
        headers: { ...bearer(s), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, { timeoutMs: req.timeoutMs, signal: req.signal });
    const v = json?.videos?.[0] || json?.data?.[0];
    if (v?.url) return { url: v.url, mime: v.mime_type || 'video/mp4' };
    if (v?.b64_json) return { dataUrl: `data:${v.mime_type || 'video/mp4'};base64,${v.b64_json}` };
    if (json?.error) throw new Error(`Provider error: ${json.error.message || 'unknown'}`);
    throw new Error('No video in provider response');
}
