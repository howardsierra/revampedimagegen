/*
 * Revamped Image Gen — LLM-side features: instruction injection, prompt
 * compaction and "write a prompt for this scene".
 * Licensed under AGPL-3.0-or-later.
 */

import { MODULE, SCENE_PROMPT_TEMPLATE } from './constants.js';
import { knownRefNames } from './refs.js';
import { characterExamples, settings } from './settings.js';
import { formatExamples, pickExamples } from './examples.js';
import { ctx, getCharName, getUserName, log } from './st.js';
import { formatInstructions } from './capture.js';
import { compactTags, parseTags, plainText } from './tags.js';

const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

function namesList() {
    const names = knownRefNames();
    for (const n of [getCharName(), getUserName()]) if (n && !names.includes(n)) names.push(n);
    return names.length ? names.join(', ') : 'none yet';
}

/** The example prompts that apply in this chat (character list, else global). */
export function activeExamples() {
    const s = settings();
    return pickExamples({ global: s.promptExamples, character: characterExamples() || [], max: s.examplesMax ?? 3 });
}

export function renderInjection() {
    const s = settings();
    return String(s.injectTemplate || '')
        .replaceAll('{{iig_examples}}', formatExamples(activeExamples()))
        .replaceAll('{{iig_format}}', formatInstructions(s.injectFormat, s.captureRules))
        .replaceAll('{{iig_names}}', namesList())
        .replaceAll('{{iig_max}}', String(Math.max(1, Number(s.injectMax) || 1)))
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Push (or clear) our instruction block into the next prompt. */
export function updateInjection() {
    const c = ctx();
    if (typeof c.setExtensionPrompt !== 'function') return;
    const s = settings();
    const on = s.enabled && s.inject && String(s.injectTemplate || '').trim();
    c.setExtensionPrompt(MODULE, on ? renderInjection() : '', IN_CHAT, Math.max(0, Number(s.injectDepth) || 0), false, ROLE_SYSTEM);
}

/** Replace finished image tags in the outgoing prompt with short markers. */
export function installHistoryCompaction() {
    const c = ctx();
    const types = c.eventTypes || c.event_types;
    if (types.CHAT_COMPLETION_PROMPT_READY) {
        c.eventSource.on(types.CHAT_COMPLETION_PROMPT_READY, (data) => {
            if (!settings().enabled || !settings().compactHistory || data?.dryRun || !Array.isArray(data?.chat)) return;
            for (const m of data.chat) {
                if (typeof m.content === 'string') m.content = compactTags(m.content);
                else if (Array.isArray(m.content)) {
                    for (const part of m.content) if (part?.type === 'text' && typeof part.text === 'string') part.text = compactTags(part.text);
                }
            }
        });
    }
    if (types.GENERATE_AFTER_COMBINE_PROMPTS) {
        c.eventSource.on(types.GENERATE_AFTER_COMBINE_PROMPTS, (data) => {
            if (!settings().enabled || !settings().compactHistory || data?.dryRun || typeof data?.prompt !== 'string') return;
            data.prompt = compactTags(data.prompt);
        });
    }
}

/** Clean up what the LLM returned into a bare prompt string. */
export function cleanLlmPrompt(text) {
    let s = String(text || '').trim();
    const tag = parseTags(s)[0];
    if (tag?.data?.prompt) return tag.data.prompt;
    s = s.replace(/^```[a-z]*\n?|```$/gim, '').trim();
    s = s.replace(/^(image\s*)?prompt\s*[:\-–]\s*/i, '').trim();
    s = s.replace(/^["“'`]+|["”'`]+$/g, '').trim();
    return s;
}

async function quiet(prompt) {
    const c = ctx();
    const fn = c.generateQuietPrompt;
    if (typeof fn !== 'function') throw new Error('This SillyTavern version cannot run background prompts.');
    // Newer ST takes one options object (fn.length === 0); older builds are positional.
    return fn.length === 0
        ? fn({ quietPrompt: prompt, skipWIAN: true, removeReasoning: true })
        : fn(prompt, false, true);
}

/**
 * Ask the chat model to write an image prompt for message `mesId`
 * (or the latest message when omitted).
 */
export async function describeScene(mesId = null) {
    const c = ctx();
    const chat = c.chat || [];
    let idx = mesId;
    if (idx == null) {
        for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_system) { idx = i; break; }
    }
    const msg = chat[idx];
    if (!msg) throw new Error('No message to illustrate.');
    const scene = plainText(compactTags(msg.mes)).slice(-3000);
    // A few earlier messages, so the prompt knows where everyone is and what they wear.
    const n = Math.max(0, Math.min(12, Number(settings().sceneContext ?? 4)));
    const before = [];
    for (let i = idx - 1; i >= 0 && before.length < n; i--) {
        if (chat[i].is_system || !chat[i].mes) continue;
        before.unshift(`${chat[i].name}: ${plainText(compactTags(chat[i].mes)).slice(-1200)}`);
    }
    const instruction = SCENE_PROMPT_TEMPLATE
        .replaceAll('{{iig_names}}', namesList())
        .replaceAll('{{iig_examples}}', formatExamples(activeExamples()))
        .replaceAll('{{iig_context}}', before.join('\n\n') || '(start of the chat)')
        .replaceAll('{{iig_scene}}', `${msg.name}: ${scene}`)
        .replace(/\n{3,}/g, '\n\n');

    // Our own injection asks for <img> tags; mute it so we get a bare prompt back.
    const s = settings();
    const wasOn = s.inject;
    s.inject = false;
    updateInjection();
    try {
        const out = cleanLlmPrompt(await quiet(instruction));
        if (!out) throw new Error('The model returned an empty prompt.');
        log('info', `Scene prompt: ${out.slice(0, 120)}`);
        return out;
    } finally {
        s.inject = wasOn;
        updateInjection();
    }
}
