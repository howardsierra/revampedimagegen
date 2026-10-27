/*
 * Revamped Image Gen — settings, connection profiles and reference storage.
 * Licensed under AGPL-3.0-or-later.
 */

import { MODULE, LEGACY_MODULE, DEFAULT_STYLES, DEFAULT_INJECT_TEMPLATE } from './constants.js';
import { defaultRules, BUILTIN_RULES } from './capture.js';
import { ctx, log, setSecretsToMask, uid } from './st.js';

export const DEFAULTS = Object.freeze({
    enabled: true,
    autoGenerate: true,

    // Connection (live). Snapshots of these fields are saved as profiles.
    provider: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
    pathOverride: '',
    useCorsProxy: false,
    openaiRefMode: 'auto',          // auto | json | multipart
    openaiFidelity: true,           // input_fidelity: high on gpt-image-1.x when references are sent
    openaiModeration: 'auto',       // auto | low
    openaiFormat: 'png',            // png | jpeg | webp
    sendRefs: true,
    naisteraModel: 'grok',
    naisteraPreset: '',
    sdSteps: 28,
    sdCfg: 6,
    sdSampler: 'Euler a',
    videoModel: '',
    profiles: [],
    activeProfileId: '',

    // Generation defaults. Tag fields win unless `tagOverrides` is off.
    tagOverrides: true,
    defaultStyle: '',
    aspectRatio: '1:1',
    imageSize: 'auto',              // auto = each model's own default (e.g. 2K for Nano Banana Pro)
    quality: 'auto',
    promptPrefix: '',
    promptSuffix: '',
    negativePrompt: '',
    styles: DEFAULT_STYLES.map(s => ({ ...s })),

    // Video
    videoDuration: 4,
    videoResolution: '480p',
    videoAudio: false,

    // Queue / network
    concurrency: 2,
    maxRetries: 2,
    retryDelay: 1500,
    timeoutSec: 300,

    // LLM instructions
    inject: true,
    injectDepth: 1,
    injectMax: 2,
    injectTemplate: DEFAULT_INJECT_TEMPLATE,
    compactHistory: false,
    injectFormat: 'html',           // html | id of a capture rule the AI is told to use

    // Regex prompt capture: turn other formats in AI replies into image tags.
    captureRules: defaultRules(),

    // References
    refsEditLayer: 'chat',          // chat | character | global (which layer the Refs tab edits)
    maxRefs: 0,                     // 0 = auto (per-model sensible limit)
    charRefSets: {},
    learnedSizes: {},               // model id -> sizes the provider said it accepts
    refs: { char: { name: '', path: '', always: false }, user: { name: '', path: '', always: false }, npcs: [] },

    // Device & UI
    haptics: true,
    notify: false,
    wakeLock: true,
    showFab: true,
    fabPos: null,                   // { side: 'left'|'right', y: 0..1 }
    dock: 'auto',                   // auto | right | left | bottom
    panelWidth: 420,
    sheetSnap: 'half',              // half | full
    lastTab: 'create',
    hoverToolbar: true,
    studioDraft: { kind: 'image', prompt: '', style: '', aspect_ratio: '', image_size: '', count: 1, negative_prompt: '', seed: '', useRefs: true },

    // Results that finished after their chat was closed; applied on next open.
    pendingFixups: [],
    _importedLegacy: false,
});

export const PROFILE_FIELDS = Object.freeze([
    'provider', 'endpoint', 'apiKey', 'model', 'pathOverride', 'useCorsProxy',
    'openaiRefMode', 'sendRefs', 'naisteraModel', 'naisteraPreset', 'videoModel',
]);

let cached = null;

export function settings() {
    const store = ctx().extensionSettings;
    if (!store[MODULE]) store[MODULE] = structuredClone(DEFAULTS);
    const s = store[MODULE];
    if (cached !== s) {
        for (const [k, v] of Object.entries(DEFAULTS)) {
            if (!Object.hasOwn(s, k)) s[k] = structuredClone(v);
        }
        if (!s.refs || typeof s.refs !== 'object') s.refs = structuredClone(DEFAULTS.refs);
        if (!Array.isArray(s.captureRules)) s.captureRules = defaultRules();
        // v1.2: resolution became model-driven by default.
        if (!s._autoSizeMigrated) { s.imageSize = 'auto'; s._autoSizeMigrated = true; }
        // Add built-in rules introduced after the user's settings were created.
        for (const b of BUILTIN_RULES) {
            if (!s.captureRules.some(r => r.id === b.id)) s.captureRules.push({ id: b.id, name: b.name, pattern: b.pattern, flags: b.flags, enabled: false, builtin: true, kind: 'image' });
        }
        normalizeRefSet(s.refs);
        cached = s;
        refreshSecrets();
    }
    return s;
}

const listeners = new Set();
let saveTimer = null;
let dirty = false;

/** Persist (debounced) and notify listeners. Pass the changed key for targeted UI refresh. */
export function save(changedKey = null) {
    dirty = true;
    refreshSecrets();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
    for (const fn of listeners) {
        try { fn(changedKey); } catch (e) { log('warn', 'settings listener failed', e); }
    }
}

export function flush() {
    clearTimeout(saveTimer);
    if (!dirty) return;
    dirty = false;
    const c = ctx();
    c.saveSettingsDebounced?.();
    c.saveSettingsDebounced?.flush?.();
}

export function onSettingsChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function refreshSecrets() {
    const s = cached;
    if (!s) return;
    setSecretsToMask([s.apiKey, ...(s.profiles || []).map(p => p.apiKey)]);
}

/** Mobile browsers kill backgrounded tabs; write pending changes when that is likely. */
export function installFlushOnHide() {
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    window.addEventListener('pagehide', flush);
}

// ---------------------------------------------------------------- profiles

export function snapshotProfile(name) {
    const s = settings();
    const p = { id: uid('prof'), name };
    for (const f of PROFILE_FIELDS) p[f] = structuredClone(s[f]);
    return p;
}

export function applyProfile(id) {
    const s = settings();
    const p = s.profiles.find(x => x.id === id);
    if (!p) return false;
    for (const f of PROFILE_FIELDS) if (Object.hasOwn(p, f)) s[f] = structuredClone(p[f]);
    s.activeProfileId = id;
    save('profile');
    return true;
}

/** Write the live connection back into the active profile. */
export function updateActiveProfile() {
    const s = settings();
    const p = s.profiles.find(x => x.id === s.activeProfileId);
    if (!p) return false;
    for (const f of PROFILE_FIELDS) p[f] = structuredClone(s[f]);
    save('profile');
    return true;
}

// ---------------------------------------------------------------- references
//
// Three layers, most specific first:
//   chat       this chat only            (chat metadata: iig_refs)
//   character  every chat with this card (settings.charRefSets[avatar])
//   global     every chat                (settings.refs)
// The effective set takes Character/You from the most specific layer that has
// a photo, and merges extra characters from all layers (same name → specific
// wins). A chat can mute inherited photos it does not want.

export const LAYERS = Object.freeze(['chat', 'character', 'global']);

function normalizeSlot(slot) {
    const out = { name: '', path: '', always: false, ...(slot || {}) };
    out.name = String(out.name || '');
    out.path = String(out.path || '');
    out.always = !!out.always;
    return out;
}

export function emptyRefSet() {
    return { char: normalizeSlot(), user: normalizeSlot(), npcs: [] };
}

function normalizeRefSet(set) {
    set.char = normalizeSlot(set.char);
    set.user = normalizeSlot(set.user);
    set.npcs = Array.isArray(set.npcs) ? set.npcs.map(n => ({ id: n.id || uid('npc'), ...normalizeSlot(n) })) : [];
    if (!Array.isArray(set.muted)) set.muted = [];
    return set;
}

/** Key for the character layer: the card's avatar file, or the group id. */
export function characterKey() {
    const c = ctx();
    if (c.groupId) return `group:${c.groupId}`;
    const a = c.characters?.[c.characterId]?.avatar;
    return a && a !== 'none' ? a : '';
}

/** A layer's set, or null if it does not exist (and `create` is false). */
export function refLayer(layer, { create = false } = {}) {
    const s = settings();
    if (layer === 'global') return s.refs;
    if (layer === 'character') {
        const key = characterKey();
        if (!key) return null;
        if (!s.charRefSets || typeof s.charRefSets !== 'object') s.charRefSets = {};
        if (!s.charRefSets[key] && create) s.charRefSets[key] = emptyRefSet();
        return s.charRefSets[key] ? normalizeRefSet(s.charRefSets[key]) : null;
    }
    const meta = ctx().chatMetadata;
    if (!meta || !chatIdSafe()) return null;
    if (!meta.iig_refs && create) meta.iig_refs = emptyRefSet();
    return meta.iig_refs ? normalizeRefSet(meta.iig_refs) : null;
}

function chatIdSafe() {
    try { return ctx().getCurrentChatId?.() || ''; } catch { return ''; }
}

export function layerAvailable(layer) {
    if (layer === 'global') return true;
    if (layer === 'character') return !!characterKey();
    return !!chatIdSafe() && !!ctx().chatMetadata;
}

function mutedPaths() {
    return new Set(refLayer('chat')?.muted || []);
}

/**
 * The references used for generation, each tagged with `layer`.
 * @returns {{char: object, user: object, npcs: object[]}}
 */
export function activeRefs() {
    const muted = mutedPaths();
    const sets = LAYERS.map(l => [l, refLayer(l)]).filter(([, set]) => set);
    const pick = (kind) => {
        for (const [layer, set] of sets) {
            const slot = set[kind];
            if (slot?.path && !muted.has(slot.path)) return { ...slot, layer };
        }
        // No photo anywhere: still return the most specific name so matching hints work.
        const named = sets.find(([, set]) => set[kind]?.name);
        return named ? { ...named[1][kind], path: '', layer: named[0] } : { ...normalizeSlot(), layer: 'global' };
    };
    const npcs = [];
    const seen = new Set();
    for (const [layer, set] of sets) {
        for (const n of set.npcs || []) {
            if (!n.path || muted.has(n.path)) continue;
            const key = n.name.split(',')[0].trim().toLowerCase() || n.path;
            if (seen.has(key) || seen.has(n.path)) continue;
            seen.add(key);
            seen.add(n.path);
            npcs.push({ ...n, layer });
        }
    }
    return { char: pick('char'), user: pick('user'), npcs };
}

/** References that apply here but live in a less specific layer (for the "Inherited" list). */
export function inheritedRefs(editing) {
    const order = LAYERS.indexOf(editing);
    const out = [];
    for (const layer of LAYERS.slice(order + 1)) {
        const set = refLayer(layer);
        if (!set) continue;
        for (const [kind, slot] of [['char', set.char], ['user', set.user], ...set.npcs.map(n => ['npc', n])]) {
            if (slot?.path) out.push({ ...slot, kind, layer });
        }
    }
    return out;
}

export function isMuted(path) {
    return mutedPaths().has(path);
}

export function setMuted(path, on) {
    const set = refLayer('chat', { create: true });
    if (!set) return;
    set.muted = (set.muted || []).filter(p => p !== path);
    if (on) set.muted.push(path);
    saveRefs('chat');
}

export function saveRefs(layer = 'global') {
    const c = ctx();
    if (layer === 'chat') {
        if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else c.saveMetadata?.();
    }
    save('refs');
}

/** Remove this chat's own layer (inherited references keep working). */
export function resetChatRefs() {
    const c = ctx();
    if (c.chatMetadata?.iig_refs) {
        delete c.chatMetadata.iig_refs;
        c.saveMetadata?.();
    }
    save('refs');
}

/** Every server path any known ref set still uses (so shared files are never deleted). */
export function knownRefPaths() {
    const s = settings();
    const sets = [s.refs, ...Object.values(s.charRefSets || {})];
    const meta = ctx().chatMetadata?.iig_refs;
    if (meta) sets.push(meta);
    const out = new Set();
    for (const set of sets) {
        for (const slot of [set?.char, set?.user, ...(set?.npcs || [])]) if (slot?.path) out.add(slot.path);
    }
    return out;
}

// ---------------------------------------------------------------- legacy import

export function legacySettings() {
    return ctx().extensionSettings?.[LEGACY_MODULE] || null;
}

/** Copy connection, presets, refs and defaults from notsosillynotsoimages. */
export function importLegacy() {
    const old = legacySettings();
    if (!old) return false;
    const s = settings();
    const map = { openai: 'openai', gemini: 'gemini', naistera: 'naistera' };
    s.provider = map[old.apiType] || s.provider;
    s.endpoint = old.endpoint || s.endpoint;
    s.apiKey = old.apiKey || s.apiKey;
    s.model = old.model || s.model;
    s.pathOverride = old.pathOverride || '';
    if (old.naisteraModel) s.naisteraModel = old.naisteraModel;
    if (old.naisteraPreset) s.naisteraPreset = old.naisteraPreset;
    if (typeof old.naisteraSendRefs === 'boolean' && s.provider === 'naistera') s.sendRefs = old.naisteraSendRefs;
    if (typeof old.geminiSendRefs === 'boolean' && s.provider === 'gemini') s.sendRefs = old.geminiSendRefs;
    if (old.imageSize) s.imageSize = old.imageSize;
    if (old.quality) s.quality = old.quality;
    if (Number.isFinite(old.maxRetries)) s.maxRetries = old.maxRetries;
    if (Number.isFinite(old.retryDelay)) s.retryDelay = old.retryDelay;
    if (old.videoModel) s.videoModel = old.videoModel;
    if (old.videoDuration) s.videoDuration = old.videoDuration;
    if (old.videoResolution) s.videoResolution = old.videoResolution;
    if (typeof old.videoAudio === 'boolean') s.videoAudio = old.videoAudio;
    s.refsEditLayer = old.refScope === 'per-chat' ? 'chat' : 'global';

    const slot = (r, always) => ({ name: r?.name || '', path: r?.imagePath || '', always: !!always });
    s.refs = normalizeRefSet({
        char: slot(old.charRef, old.charRefAlways),
        user: slot(old.userRef, old.userRefAlways),
        npcs: (old.npcReferences || []).filter(n => n && (n.name || n.imagePath)).map(n => ({ id: uid('npc'), ...slot(n, false) })),
    });

    for (const p of old.presets || []) {
        if (!p?.name || s.profiles.some(x => x.name === p.name)) continue;
        s.profiles.push({
            id: uid('prof'),
            name: p.name,
            provider: map[p.apiType] || 'openai',
            endpoint: p.endpoint || '',
            apiKey: p.apiKey || '',
            model: p.model || '',
            pathOverride: p.pathOverride || '',
            useCorsProxy: false,
            openaiRefMode: 'auto',
            sendRefs: p.apiType === 'naistera' ? p.naisteraSendRefs !== false : p.geminiSendRefs !== false,
            naisteraModel: p.naisteraModel || 'grok',
            naisteraPreset: '',
            videoModel: p.videoModel || '',
        });
    }
    s._importedLegacy = true;
    save('all');
    log('info', 'Imported settings from notsosillynotsoimages');
    return true;
}
