/*
 * Revamped Image Gen — tag parsing. Pure functions, no SillyTavern globals,
 * so this module is unit-tested under Node (see test/tags.test.mjs).
 *
 * Based on notsosillynotsoimages by aceeenvw (AGPL-3.0-or-later).
 *
 * Supported forms (compatible with notsosillynotsoimages chats):
 *   <img data-iig-instruction='{"prompt":"…"}' src="[IMG:GEN]">
 *   <img data-iig-video='{"prompt":"…"}' src="[VID:GEN]">
 *   [IMG:GEN:{"prompt":"…"}]   [VID:GEN:{"prompt":"…"}]
 *   [IMG:✓:/user/images/…]     (legacy "done" marker)
 */

const ATTRS = { image: 'data-iig-instruction', video: 'data-iig-video' };
const LEGACY = { image: '[IMG:GEN:', video: '[VID:GEN:' };

export function decodeEntities(text) {
    return String(text ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Escape a JSON string so it can sit inside a single-quoted HTML attribute. */
export function escapeSingleQuotedAttr(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Index just past the `}` that closes the `{` at `start`, or -1.
 * Tracks double-quoted string literals and backslash escapes; apostrophes in
 * prompts ("Axel's") are ordinary characters here.
 */
export function findJsonEnd(text, start) {
    let depth = 0;
    let quote = null;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"') { quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
}

const KEY_ALIASES = {
    prompt: 'prompt', description: 'prompt', desc: 'prompt',
    style: 'style',
    aspect_ratio: 'aspect_ratio', aspectratio: 'aspect_ratio', ar: 'aspect_ratio', ratio: 'aspect_ratio',
    image_size: 'image_size', imagesize: 'image_size', resolution: 'resolution',
    quality: 'quality',
    preset: 'preset',
    negative_prompt: 'negative_prompt', negativeprompt: 'negative_prompt', negative: 'negative_prompt',
    seed: 'seed',
    duration: 'duration',
    audio: 'audio',
    ref_mode: 'ref_mode', refmode: 'ref_mode',
    ref_names: 'ref_names', refnames: 'ref_names', no_refs: 'no_refs', norefs: 'no_refs',
};

function normalizeKeys(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
        const key = KEY_ALIASES[String(k).toLowerCase()] || k;
        if (!(key in out)) out[key] = v;
    }
    return out;
}

/**
 * Lenient key/value extraction for payloads JSON.parse rejects — LLMs emit
 * unescaped quotes in prompts, trailing commas, single-quoted strings, etc.
 */
function parseRelaxed(payload) {
    const keyRe = /(["']?)([A-Za-z_]+)\1\s*:\s*/g;
    const found = [];
    let m;
    while ((m = keyRe.exec(payload))) {
        const name = m[2].toLowerCase();
        if (!KEY_ALIASES[name]) continue;
        // Only accept keys at the top level of the object (preceded by { or ,).
        const before = payload.slice(0, m.index).trimEnd();
        if (!before.endsWith('{') && !before.endsWith(',')) continue;
        found.push({ name, valueStart: m.index + m[0].length, keyStart: m.index });
    }
    if (!found.length) return null;
    const close = payload.lastIndexOf('}');
    const result = {};
    for (let i = 0; i < found.length; i++) {
        const end = i + 1 < found.length ? found[i + 1].keyStart : (close === -1 ? payload.length : close);
        let raw = payload.slice(found[i].valueStart, end).trim();
        if (raw.endsWith(',')) raw = raw.slice(0, -1).trimEnd();
        let value;
        const q = raw[0];
        if ((q === '"' || q === "'") && raw.endsWith(q) && raw.length >= 2) {
            value = raw.slice(1, -1)
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\(["'\\])/g, '$1');
        } else if (raw === 'true' || raw === 'false') {
            value = raw === 'true';
        } else if (raw !== '' && !Number.isNaN(Number(raw))) {
            value = Number(raw);
        } else {
            value = raw.replace(/^["']|["']$/g, '');
        }
        result[found[i].name] = value;
    }
    return result;
}

/** Parse an instruction payload into a normalized object. Throws if hopeless. */
export function parseInstruction(payload) {
    const text = decodeEntities(payload).trim();
    let obj;
    try {
        obj = JSON.parse(text);
    } catch (strictError) {
        try {
            obj = JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
        } catch {
            obj = parseRelaxed(text);
            if (!obj) throw strictError;
        }
    }
    const data = normalizeKeys(obj);
    if (typeof data.prompt !== 'string') data.prompt = data.prompt == null ? '' : String(data.prompt);
    data.prompt = data.prompt.trim();
    return data;
}

/** Classify an img src: pending (needs generation), error, or done (has a real file). */
export function srcState(src) {
    const s = String(src ?? '').trim();
    if (!s || s === '#' || /\[(IMG|VID):GEN\]/i.test(s) || /^\[(IMG|VID):/i.test(s) && !/ERROR/i.test(s)) return 'pending';
    if (/error\.svg/i.test(s) || /\[(IMG|VID):ERROR/i.test(s)) return 'error';
    return 'done';
}

/** Locate the src attribute in `tag`, ignoring anything inside [skipStart, skipEnd). */
function findSrcAttr(tag, skipStart, skipEnd) {
    const re = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let m;
    while ((m = re.exec(tag))) {
        if (m.index >= skipStart && m.index < skipEnd) continue;
        return { start: m.index, end: m.index + m[0].length, value: m[1] ?? m[2] ?? m[3] ?? '' };
    }
    return null;
}

function scanHtmlTags(text, kind, out) {
    const attr = ATTRS[kind];
    const marker = `${attr}=`;
    let pos = 0;
    while (true) {
        const markerPos = text.indexOf(marker, pos);
        if (markerPos === -1) break;
        pos = markerPos + marker.length;

        const imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || text.slice(imgStart, markerPos).includes('>')) continue;

        const jsonStart = text.indexOf('{', pos);
        if (jsonStart === -1 || jsonStart - pos > 3) continue;
        const jsonEnd = findJsonEnd(text, jsonStart);
        if (jsonEnd === -1) continue;

        // The attribute is closed by its quote right after the JSON.
        let tagEnd = text.indexOf('>', jsonEnd);
        if (tagEnd === -1) continue;
        tagEnd++;

        const fullMatch = text.slice(imgStart, tagEnd);
        const relJsonStart = jsonStart - imgStart;
        const relJsonEnd = jsonEnd - imgStart;
        const src = findSrcAttr(fullMatch, relJsonStart, relJsonEnd);
        let data;
        try {
            data = parseInstruction(text.slice(jsonStart, jsonEnd));
        } catch {
            pos = tagEnd;
            continue;
        }
        out.push({
            kind,
            format: 'html',
            index: imgStart,
            fullMatch,
            json: text.slice(jsonStart, jsonEnd),
            src: src ? src.value : '',
            state: srcState(src ? src.value : ''),
            data,
        });
        pos = tagEnd;
    }
}

function scanLegacyTags(text, kind, out) {
    const marker = LEGACY[kind];
    let pos = 0;
    while (true) {
        const start = text.indexOf(marker, pos);
        if (start === -1) break;
        const jsonStart = start + marker.length;
        pos = jsonStart;
        if (text[jsonStart] !== '{') continue;
        const jsonEnd = findJsonEnd(text, jsonStart);
        if (jsonEnd === -1 || text[jsonEnd] !== ']') continue;
        let data;
        try {
            data = parseInstruction(text.slice(jsonStart, jsonEnd));
        } catch {
            continue;
        }
        out.push({
            kind,
            format: 'legacy',
            index: start,
            fullMatch: text.slice(start, jsonEnd + 1),
            json: text.slice(jsonStart, jsonEnd),
            src: '',
            state: 'pending',
            data,
        });
        pos = jsonEnd + 1;
    }
}

/**
 * Find all media tags in `text`, in document order.
 * @returns {Array<{kind:'image'|'video', format:'html'|'legacy', index:number, fullMatch:string, json:string, src:string, state:'pending'|'done'|'error', data:object}>}
 */
export function parseTags(text) {
    const out = [];
    if (!text || typeof text !== 'string') return out;
    if (text.includes(ATTRS.image)) scanHtmlTags(text, 'image', out);
    if (text.includes(ATTRS.video)) scanHtmlTags(text, 'video', out);
    if (text.includes(LEGACY.image)) scanLegacyTags(text, 'image', out);
    if (text.includes(LEGACY.video)) scanLegacyTags(text, 'video', out);
    return out.sort((a, b) => a.index - b.index);
}

/** Build a fresh HTML tag for the given kind/data/src. */
export function buildTag(kind, data, src) {
    const attr = ATTRS[kind] || ATTRS.image;
    const clean = {};
    for (const [k, v] of Object.entries(data || {})) {
        if (v !== undefined && v !== null && v !== '') clean[k] = v;
    }
    return `<img ${attr}='${escapeSingleQuotedAttr(JSON.stringify(clean))}' src="${escapeHtml(src)}">`;
}

/**
 * Return `tag.fullMatch` rewritten to point at `newSrc`. Legacy bracket tags
 * are upgraded to the HTML form so the finished image actually renders.
 */
export function withSrc(tag, newSrc) {
    if (tag.format === 'legacy') return buildTag(tag.kind, tag.data, newSrc);
    const full = tag.fullMatch;
    const jsonAt = full.indexOf(tag.json);
    const src = findSrcAttr(full, jsonAt, jsonAt + tag.json.length);
    const attr = ` src="${escapeHtml(newSrc)}"`;
    if (src) return full.slice(0, src.start) + attr + full.slice(src.end);
    const close = full.endsWith('/>') ? full.length - 2 : full.length - 1;
    return full.slice(0, close).trimEnd() + attr + full.slice(close);
}

/** Return `tag.fullMatch` with its instruction JSON replaced by `data`. */
export function withData(tag, data) {
    const json = JSON.stringify(data);
    if (tag.format === 'legacy') return `${LEGACY[tag.kind]}${json}]`;
    const full = tag.fullMatch;
    const at = full.indexOf(tag.json);
    if (at === -1) return full;
    // The original attribute may be single- or double-quoted.
    const quote = full[at - 1];
    const encoded = quote === '"'
        ? escapeHtml(json)
        : escapeSingleQuotedAttr(json);
    return full.slice(0, at) + encoded + full.slice(at + tag.json.length);
}

/**
 * Replace completed tags with a short marker before the chat is sent to the
 * LLM. Saves tokens and stops models from copying old file paths.
 */
export function compactTags(text, maxPromptChars = 120) {
    const tags = parseTags(text).filter(t => t.state === 'done');
    if (!tags.length) return text;
    let out = '';
    let last = 0;
    for (const t of tags) {
        out += text.slice(last, t.index);
        const p = t.data.prompt.length > maxPromptChars ? `${t.data.prompt.slice(0, maxPromptChars)}…` : t.data.prompt;
        out += `[${t.kind === 'video' ? 'video' : 'image'} shown: ${p}]`;
        last = t.index + t.fullMatch.length;
    }
    return out + text.slice(last);
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split "Elodie, Lodi , Ellie" into trimmed, non-empty aliases. */
export function splitAliases(nameField) {
    return String(nameField ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Whole-word, case-insensitive, Unicode-aware alias match.
 * "Lodi" matches "Lodi waves" but not "melodies"; works for Cyrillic, accents, CJK-adjacent text.
 */
export function nameInText(nameField, text) {
    const hay = String(text ?? '');
    if (!hay) return false;
    for (const alias of splitAliases(nameField)) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(alias)}(?![\\p{L}\\p{N}_])`, 'iu');
        if (re.test(hay)) return true;
    }
    return false;
}

/** Strip HTML and our tags from message text (used to give the LLM a clean scene). */
export function plainText(text) {
    let s = String(text ?? '');
    for (const t of parseTags(s).reverse()) {
        s = s.slice(0, t.index) + s.slice(t.index + t.fullMatch.length);
    }
    return s
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
