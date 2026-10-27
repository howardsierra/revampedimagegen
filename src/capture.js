/*
 * Revamped Image Gen — regex prompt capture.
 *
 * Lets the AI write image requests in any format (simpler formats are far
 * more reliable for weaker models and cost fewer tokens). Each enabled rule's
 * matches are converted into standard pending tags, which the normal pipeline
 * then generates. Pure functions; unit-tested in test/capture.test.mjs.
 * Licensed under AGPL-3.0-or-later.
 */

import { ASPECT_RATIOS } from './constants.js';
import { buildTag, decodeEntities, parseTags } from './tags.js';

/**
 * Built-in rules. Patterns use a named group `prompt`; optional named groups
 * `style`, `ar`, `size`, `neg` fill the other fields.
 */
export const BUILTIN_RULES = Object.freeze([
    {
        id: 'bracket',
        name: '[IMG: prompt]',
        pattern: String.raw`\[(?:img|image|pic|picture)\s*:\s*(?!GEN\b|✓|ERROR\b)(?<prompt>[^\]]{3,})\]`,
        flags: 'gi',
        example: '[IMG: detailed prompt --ar 16:9]',
    },
    {
        id: 'xml',
        name: '<image>prompt</image>',
        pattern: String.raw`<(image|pic|illustration)(?:\s[^>]*)?>(?<prompt>[\s\S]{3,}?)<\/\1\s*>`,
        flags: 'gi',
        example: '<image>detailed prompt --ar 16:9</image>',
    },
    {
        id: 'comment',
        name: '<!-- image: prompt --> (hidden)',
        pattern: String.raw`<!--\s*(?:image|img|pic)\s*:\s*(?<prompt>[\s\S]+?)\s*-->`,
        flags: 'gi',
        example: '<!-- image: detailed prompt --ar 16:9 -->',
    },
    {
        id: 'line',
        name: 'Image prompt: … (own line)',
        pattern: String.raw`^[ \t>*_]*(?:image|scene|illustration)[ \t]+prompt[*_]*[ \t]*:[*_]*[ \t]*(?<prompt>.+)$`,
        flags: 'gim',
        example: 'Image prompt: detailed prompt --ar 16:9',
    },
    {
        // Clover OOC (github.com/aceeenvw/clover-ooc): an "Image generation:" order inside <ooc> tags.
        id: 'clover',
        name: 'Clover <ooc> Image generation: …',
        pattern: String.raw`<ooc>\s*image[ \t]+generation[ \t]*:[ \t]*(?<prompt>[\s\S]{3,}?)\s*<\/ooc>`,
        flags: 'gi',
        example: '<ooc>Image generation: detailed prompt --ar 16:9</ooc>',
    },
]);

export function defaultRules() {
    return BUILTIN_RULES.map(r => ({ id: r.id, name: r.name, pattern: r.pattern, flags: r.flags, enabled: false, builtin: true, kind: 'image' }));
}

/** Compile a rule; returns null (and the error) for invalid patterns. */
export function compileRule(rule) {
    try {
        let flags = String(rule.flags || 'gi');
        if (!flags.includes('g')) flags += 'g';
        flags = [...new Set(flags.replace(/[^dgimsuvy]/g, ''))].join('');
        return { re: new RegExp(rule.pattern, flags), error: null };
    } catch (e) {
        return { re: null, error: e.message };
    }
}

const FLAG_RE = /\s--(ar|aspect|style|size|res|no|neg|seed)\s+((?:(?!\s--[a-z]).)+)/gi;

/**
 * Split Midjourney-style flags off a captured prompt:
 * "a cat --ar 16:9 --style watercolor --no text" → { prompt, aspect_ratio, style, negative_prompt }.
 */
export function parseFlags(raw) {
    const data = {};
    const prompt = String(raw).replace(FLAG_RE, (_, k, v) => {
        const key = k.toLowerCase();
        const val = v.trim();
        if (key === 'ar' || key === 'aspect') {
            // "--ar 9x16 and more words": only the ratio is the flag; the rest stays in the prompt.
            const m = val.match(/^(\d+)\s*[:x×]\s*(\d+)\b\s*([\s\S]*)$/i);
            if (!m) { data.aspect_ratio = val.replace(/\s/g, ''); return ''; }
            data.aspect_ratio = `${m[1]}:${m[2]}`;
            return m[3] ? ` ${m[3]}` : '';
        }
        if (key === 'style') data.style = val;
        else if (key === 'size' || key === 'res') data.image_size = val.toUpperCase();
        else if (key === 'no' || key === 'neg') data.negative_prompt = val;
        else if (key === 'seed' && /^\d+$/.test(val)) data.seed = Number(val);
        return '';
    });
    data.prompt = prompt;
    return data;
}

function cleanPrompt(s) {
    return decodeEntities(String(s ?? ''))
        .replace(/<[^>]+>/g, ' ')
        .replace(/^["'“”`]+|["'“”`]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Turn one match into instruction data, or null if it holds no usable prompt. */
function matchToData(match, groups) {
    const g = groups || {};
    const raw = g.prompt ?? match[1] ?? '';
    const data = parseFlags(cleanPrompt(raw));
    data.prompt = cleanPrompt(data.prompt);
    if (g.style) data.style = cleanPrompt(g.style);
    if (g.ar) data.aspect_ratio = cleanPrompt(g.ar).replace(/\s/g, '');
    if (g.size) data.image_size = cleanPrompt(g.size).toUpperCase();
    if (g.neg) data.negative_prompt = cleanPrompt(g.neg);
    if (data.aspect_ratio && !ASPECT_RATIOS.includes(data.aspect_ratio)) delete data.aspect_ratio;
    if (data.prompt.length < 3) return null;
    return data;
}

/**
 * Apply capture rules to `text`.
 * @returns {{ text: string, captured: Array<{rule: string, data: object}>, errors: Array<{rule: string, error: string}> }}
 */
export function applyCapture(text, rules) {
    const captured = [];
    const errors = [];
    let out = String(text ?? '');
    for (const rule of rules || []) {
        if (!rule?.enabled || !rule.pattern) continue;
        const { re, error } = compileRule(rule);
        if (!re) { errors.push({ rule: rule.name || rule.id, error }); continue; }
        // Never touch text inside existing image tags (their prompts may contain anything).
        const protectedRanges = parseTags(out).map(t => [t.index, t.index + t.fullMatch.length]);
        const inside = (at, len) => protectedRanges.some(([a, b]) => at < b && at + len > a);
        out = out.replace(re, (...args) => {
            const hasGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
            const groups = hasGroups ? args[args.length - 1] : undefined;
            const offset = hasGroups ? args[args.length - 3] : args[args.length - 2];
            const match = args.slice(0, hasGroups ? -3 : -2);
            if (inside(offset, match[0].length)) return match[0];
            const data = matchToData(match, groups);
            if (!data) return match[0];
            const kind = rule.kind === 'video' ? 'video' : 'image';
            captured.push({ rule: rule.name || rule.id, data });
            const tag = buildTag(kind, data, kind === 'video' ? '[VID:GEN]' : '[IMG:GEN]');
            return rule.keepText ? `${match[0]}\n${tag}` : tag;
        });
    }
    return { text: out, captured, errors };
}

/** The instruction lines that teach the AI a format, for {{iig_format}}. */
export function formatInstructions(formatId, rules = []) {
    if (!formatId || formatId === 'html') {
        return `Format:
<img data-iig-instruction='{"style":"STYLE","prompt":"PROMPT","aspect_ratio":"RATIO","image_size":"1K"}' src="[IMG:GEN]">
- Wrap the attribute in SINGLE quotes and use DOUBLE quotes inside the JSON.
- RATIO: one of 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9 — pick what suits the composition.
- Every new image must use src="[IMG:GEN]". Never copy src paths from earlier messages.`;
    }
    const builtin = BUILTIN_RULES.find(r => r.id === formatId);
    const custom = rules.find(r => r.id === formatId);
    const example = builtin?.example || custom?.example || custom?.name || '[IMG: PROMPT]';
    return `Format: ${example.replace('detailed prompt', 'PROMPT')}
- Optional flags at the end of PROMPT: --ar RATIO (1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9), --style STYLE, --no THINGS_TO_AVOID.
- Write the request exactly in this format; it is turned into a picture automatically.`;
}
