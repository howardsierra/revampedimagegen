/*
 * Revamped Image Gen — what each image model can do, and one-tap setups.
 *
 * Model IDs and limits come from the official SDK type definitions
 * (openai@7.43 `ImageModel`, @google/genai@2.31 model list / ImageConfig).
 * Unknown models get permissive defaults; providers fall back gracefully if a
 * parameter is rejected. Licensed under AGPL-3.0-or-later.
 */

/**
 * @typedef {object} ModelCaps
 * @property {string} family     'nano-banana' | 'gpt-image' | 'dall-e' | 'other'
 * @property {string} label      friendly name
 * @property {string[]} sizes    supported image_size values
 * @property {string[]|null} ratios  supported aspect ratios (null = any)
 * @property {number} maxRefs    sensible default for character references
 * @property {number} hardRefs   API maximum for input images
 * @property {string[]} qualities
 * @property {boolean} [freeSize]      arbitrary WIDTHxHEIGHT (gpt-image-2+)
 * @property {boolean} [fidelity]      supports input_fidelity: high
 * @property {boolean} [sendImageSize] include imageConfig.imageSize (Gemini)
 * @property {string} note
 */

const GEMINI_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];
const GPT_Q = ['auto', 'low', 'medium', 'high'];

// rank: higher = preferred when auto-picking from the models a key can use.
// defaultSize: what "Auto" resolution means for this model.
const TABLE = [
    // ---- Nano Banana (Gemini image models)
    { re: /gemini-3-pro-image|nano-banana-pro/i, caps: { family: 'nano-banana', label: 'Nano Banana Pro', sizes: ['1K', '2K', '4K'], defaultSize: '2K', rank: 80, ratios: GEMINI_RATIOS, maxRefs: 5, hardRefs: 14, qualities: [], sendImageSize: true, note: 'Best quality and text rendering. Up to 14 input images, 5 of them people.' } },
    { re: /nano-banana-2\.1|gemini-nano-banana-2\.1/i, caps: { family: 'nano-banana', label: 'Nano Banana 2.1', sizes: ['512', '1K', '2K', '4K'], defaultSize: '1K', rank: 92, ratios: GEMINI_RATIOS, maxRefs: 5, hardRefs: 14, qualities: [], sendImageSize: true, note: 'Fast Flash-class model with high-resolution output.' } },
    { re: /gemini-3\.1-flash-lite-image|nano-banana-2-lite/i, caps: { family: 'nano-banana', label: 'Nano Banana 2 Lite', sizes: ['512', '1K'], defaultSize: '1K', rank: 40, ratios: GEMINI_RATIOS, maxRefs: 3, hardRefs: 6, qualities: [], sendImageSize: true, note: 'Cheapest and fastest; lower detail.' } },
    { re: /gemini-3\.1-flash-image|nano-banana-2(?![.\d])/i, caps: { family: 'nano-banana', label: 'Nano Banana 2', sizes: ['512', '1K', '2K', '4K'], defaultSize: '1K', rank: 90, ratios: GEMINI_RATIOS, maxRefs: 5, hardRefs: 14, qualities: [], sendImageSize: true, note: 'Fast, good character consistency, up to 4K.' } },
    { re: /gemini-2\.5-flash-image|(^|\/)nano-banana$/i, caps: { family: 'nano-banana', label: 'Nano Banana', sizes: ['1K'], defaultSize: '1K', rank: 60, ratios: GEMINI_RATIOS, maxRefs: 3, hardRefs: 3, qualities: [], sendImageSize: false, note: 'Original Nano Banana. 1K only; works best with up to 3 input images.' } },
    { re: /^(?!.*imagen).*gemini.*image/i, caps: { family: 'nano-banana', label: 'Gemini image', sizes: ['1K', '2K', '4K'], defaultSize: '1K', rank: 30, ratios: GEMINI_RATIOS, maxRefs: 3, hardRefs: 14, qualities: [], sendImageSize: true, note: '' } },
    { re: /imagen/i, caps: { family: 'imagen', label: 'Imagen', sizes: ['1K', '2K'], defaultSize: '1K', rank: 0, ratios: null, maxRefs: 0, hardRefs: 0, qualities: [], unsupported: 'Imagen uses a different API (:predict) — use a Nano Banana model instead.', note: '' } },

    // ---- GPT Image (OpenAI)
    { re: /gpt-image-2\.5/i, caps: { family: 'gpt-image', label: 'GPT Image 2.5', sizes: ['1K', '2K', '4K'], defaultSize: '1K', rank: 85, ratios: null, maxRefs: 5, hardRefs: 16, qualities: [...GPT_Q, 'xhigh', 'max'], freeSize: true, note: 'Any size up to 3840×2160. Flare is faster; Sunburst is more detailed and better at edits.' } },
    { re: /gpt-image-2/i, caps: { family: 'gpt-image', label: 'GPT Image 2', sizes: ['1K', '2K', '4K'], defaultSize: '1K', rank: 88, ratios: null, maxRefs: 5, hardRefs: 16, qualities: GPT_Q, freeSize: true, note: 'Any size up to 3840×2160 (above 2560×1440 is experimental).' } },
    { re: /gpt-image-1-mini/i, caps: { family: 'gpt-image', label: 'GPT Image 1 mini', sizes: ['1K'], defaultSize: '1K', rank: 50, ratios: null, maxRefs: 4, hardRefs: 16, qualities: GPT_Q, note: 'Cheapest GPT Image. Square, 3:2 or 2:3 only.' } },
    { re: /gpt-image-1(\.5)?|chatgpt-image/i, caps: { family: 'gpt-image', label: 'GPT Image 1.x', sizes: ['1K'], defaultSize: '1K', rank: 70, ratios: null, maxRefs: 4, hardRefs: 16, qualities: GPT_Q, fidelity: true, note: 'Square, 3:2 or 2:3. "High input fidelity" keeps faces closer to references.' } },
    { re: /gpt-[0-9.]+-image/i, caps: { family: 'gpt-image', label: 'GPT image (chat)', sizes: ['1K'], defaultSize: '1K', rank: 55, ratios: null, maxRefs: 4, hardRefs: 10, qualities: [], note: 'Chat model with image output (via OpenRouter).' } },
    { re: /dall-e-3/i, caps: { family: 'dall-e', label: 'DALL·E 3', sizes: ['1K', '2K'], defaultSize: '1K', rank: 10, ratios: null, maxRefs: 0, hardRefs: 0, qualities: ['standard', 'hd'], note: 'Retired by OpenAI; no reference images.' } },
];

const FALLBACK = { family: 'other', label: '', sizes: ['1K', '2K', '4K'], defaultSize: '1K', rank: 1, ratios: null, maxRefs: 4, hardRefs: 8, qualities: ['auto', 'low', 'medium', 'high', 'standard', 'hd'], note: '' };

/** Does this id look like an image-generation model? (Used to filter long model lists.) */
export function isImageModelId(id) {
    const m = String(id || '').toLowerCase();
    if (/embed|tts|audio|whisper|transcri|moderation|lyria|robotics|veo|sora|video/.test(m)) return false;
    return /image|banana|dall-e|flux|stable|sdxl|diffusion|seedream|ideogram|recraft|kolors|hidream|midjourney|qwen-image|grok-2-image|imagen/.test(m);
}

/**
 * The best model for `provider` among `ids` (what the user's key can use),
 * or null. Prefers the ranks above; ignores unsupported models.
 */
export function bestModel(ids) {
    let best = null;
    let bestRank = -1;
    for (const id of ids || []) {
        const c = modelCaps(id);
        if (c.unsupported || c.family === 'other') continue;
        // Prefer stable ids over dated snapshots / previews when ranks tie.
        const rank = c.rank - (/preview|\d{4}-\d{2}-\d{2}|exp/i.test(id) ? 0.5 : 0);
        if (rank > bestRank) { best = id; bestRank = rank; }
    }
    return best;
}

/** "Auto" resolution for a model, or the requested size clamped to what it supports. */
export function sizeFor(model, requested = 'auto') {
    const c = modelCaps(model);
    if (!requested || requested === 'auto') return c.defaultSize || '1K';
    return clampSize(requested, c.sizes);
}

// Display names some providers report for their own ids (NanoGPT: an id
// with the name "Nano Banana Pro"). Used when the id alone is not recognised.
const NAMES = new Map();

/** Remember provider-reported display names: { id: name }. */
export function registerModelNames(names) {
    for (const [id, name] of Object.entries(names || {})) if (id && name) NAMES.set(id, String(name));
}

/** Provider-reported display name for an id, or ''. */
export function modelName(id) {
    return NAMES.get(String(id || '')) || '';
}

function matchCaps(text) {
    for (const row of TABLE) if (row.re.test(text)) return row.caps;
    return null;
}

/** Capabilities for a model id (provider prefixes like "google/" are fine). */
export function modelCaps(model) {
    const id = String(model || '');
    const byId = matchCaps(id);
    if (byId) return byId;
    const name = modelName(id);
    const byName = name ? matchCaps(name.trim().toLowerCase().replace(/\s+/g, '-')) : null;
    if (byName) return byName;
    return name ? { ...FALLBACK, label: name } : FALLBACK;
}

/** Nearest supported aspect ratio (e.g. 4:5 → 3:4 for Nano Banana). */
export function nearestRatio(ar, ratios) {
    if (!ratios || ratios.includes(ar)) return ar;
    const r = (x) => { const [w, h] = String(x).split(':').map(Number); return w / h; };
    const target = Math.log(r(ar) || 1);
    return ratios.reduce((best, c) => (Math.abs(Math.log(r(c)) - target) < Math.abs(Math.log(r(best)) - target) ? c : best), ratios[0]);
}

/** Closest supported image size (e.g. 4K → 1K on original Nano Banana). */
export function clampSize(size, sizes) {
    if (!sizes?.length || sizes.includes(size)) return size;
    const order = ['512', '1K', '2K', '4K'];
    const i = order.indexOf(size);
    const below = sizes.filter(s => order.indexOf(s) <= i).sort((a, b) => order.indexOf(b) - order.indexOf(a));
    return below[0] || sizes[0];
}

/**
 * Exact WIDTHxHEIGHT for gpt-image-2+: sides divisible by 16, ratio within
 * 1:3–3:1, long edge ≤ 3840 and total ≤ 3840×2160 pixels.
 */
export function gptFreeSize(ar, imageSize) {
    let [w, h] = String(ar || '1:1').split(':').map(Number);
    if (!(w > 0 && h > 0)) [w, h] = [1, 1];
    const ratio = Math.min(3, Math.max(1 / 3, w / h));
    const long = { '512': 768, '1K': 1536, '2K': 2560, '4K': 3840 }[imageSize] || 1536;
    let W = ratio >= 1 ? long : long * ratio;
    let H = ratio >= 1 ? long / ratio : long;
    const maxPx = 3840 * 2160;
    if (W * H > maxPx) {
        const k = Math.sqrt(maxPx / (W * H));
        W *= k;
        H *= k;
    }
    const snap = v => Math.max(256, Math.floor(v / 16) * 16);
    return `${snap(W)}x${snap(H)}`;
}

/** Standard GPT Image 1.x sizes. */
export function gptStandardSize(ar) {
    const [w, h] = String(ar || '1:1').split(':').map(Number);
    const r = w / h;
    if (r > 1.15) return '1536x1024';
    if (r < 0.87) return '1024x1536';
    return '1024x1024';
}

/**
 * One-tap setups for the two model families this extension is tuned for.
 * `models` are offered as chips; the first is the default.
 */
export const RECIPES = [
    {
        id: 'nb-google',
        title: 'Nano Banana',
        subtitle: 'Google AI Studio key',
        icon: 'wand-magic-sparkles',
        provider: 'gemini',
        endpoint: 'https://generativelanguage.googleapis.com',
        keyHint: 'Get a key at aistudio.google.com',
        // Suggestions only — the picker checks them against the models your key can actually use.
        models: ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-nano-banana-2.1', 'gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image'],
    },
    {
        id: 'gpt-openai',
        title: 'GPT Image',
        subtitle: 'OpenAI API key',
        icon: 'image',
        provider: 'openai',
        endpoint: 'https://api.openai.com',
        keyHint: 'Get a key at platform.openai.com',
        models: ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'gpt-image-1-mini'],
    },
    {
        id: 'openrouter',
        title: 'Both via OpenRouter',
        subtitle: 'One key for Nano Banana and GPT',
        icon: 'shuffle',
        provider: 'openrouter',
        endpoint: 'https://openrouter.ai/api',
        keyHint: 'Get a key at openrouter.ai — then tap Fetch to list image models',
        models: [],
    },
    {
        id: 'nanogpt',
        title: 'Both via NanoGPT',
        subtitle: 'NanoGPT key — pay per image',
        icon: 'bolt',
        provider: 'nanogpt',
        endpoint: 'https://nano-gpt.com',
        keyHint: 'Get a key at nano-gpt.com/api — image models are listed from your account',
        models: [],
    },
];
