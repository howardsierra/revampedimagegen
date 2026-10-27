/*
 * Revamped Image Gen — chat integration.
 *
 * Source of truth is the message text (`message.mes`): a tag is pending until
 * its src points at a file. The DOM is "rendered source + live placeholders for
 * running jobs", so ST re-rendering a message (edit, swipe, more-messages) never
 * loses track of a generation: placeholders are simply re-attached.
 *
 * Based on notsosillynotsoimages by aceeenvw (AGPL-3.0-or-later).
 */

import { generate, hintFor } from './engine.js';
import { describeScene } from './prompt.js';
import * as queue from './queue.js';
import { settings, save } from './settings.js';
import { assetUrl, chatId, ctx, haptic, isAbort, log, toast } from './st.js';
import { applyCapture } from './capture.js';
import { buildTag, escapeHtml, parseInstruction, parseTags, withData, withSrc } from './tags.js';
import { h, icon, fmtElapsed } from './ui/dom.js';

const inflight = new Map(); // `${chat}|${mesId}|${fullMatch}` -> jobId
let applyChain = Promise.resolve();

export const errorSrc = () => assetUrl('error.svg');

function mesEl(mesId) {
    return document.querySelector(`#chat .mes[mesid="${mesId}"]`);
}

function mesTextEl(mesId) {
    return mesEl(mesId)?.querySelector('.mes_text') || null;
}

// ---------------------------------------------------------------- source edits

function replaceEverywhere(message, find, replacement) {
    let hit = false;
    const rep = (s) => {
        if (typeof s !== 'string' || !s.includes(find)) return s;
        hit = true;
        return s.split(find).join(replacement);
    };
    message.mes = rep(message.mes);
    if (message.extra?.display_text) message.extra.display_text = rep(message.extra.display_text);
    if (Array.isArray(message.swipes)) message.swipes = message.swipes.map(rep);
    if (Array.isArray(message.swipe_info)) {
        for (const info of message.swipe_info) {
            if (info?.extra?.display_text) info.extra.display_text = rep(info.extra.display_text);
        }
    }
    return hit;
}

/**
 * Swap `find` → `replacement` in message `mesId` of chat `forChat` and save.
 * Serialized, so parallel jobs never clobber each other's writes. If the user
 * switched chats meanwhile, the edit is parked and applied when they return.
 */
export function applyEdit(forChat, mesId, find, replacement) {
    const run = async () => {
        if (forChat !== chatId()) {
            const s = settings();
            s.pendingFixups.push({ chatId: forChat, mesId, find, replacement, t: Date.now() });
            if (s.pendingFixups.length > 200) s.pendingFixups.splice(0, s.pendingFixups.length - 200);
            save();
            log('info', `Chat changed during generation; parked result for ${forChat}`);
            return { mesId: null, parked: true };
        }
        const chat = ctx().chat;
        let target = chat[mesId] && replaceEverywhere(chat[mesId], find, replacement) ? mesId : null;
        if (target === null) {
            // Messages above were deleted, or the message moved: search the whole chat.
            for (let i = chat.length - 1; i >= 0; i--) {
                if (replaceEverywhere(chat[i], find, replacement)) { target = i; break; }
            }
        }
        if (target === null) {
            log('warn', 'Tag not found in chat anymore (message edited or deleted); result kept in gallery only');
            return { mesId: null };
        }
        await ctx().saveChat();
        return { mesId: target };
    };
    const p = applyChain.then(run, run);
    applyChain = p.catch(() => {});
    return p;
}

/** Apply edits that finished while their chat was closed. */
export async function applyPendingFixups() {
    const s = settings();
    const id = chatId();
    if (!id || !s.pendingFixups.length) return;
    const mine = s.pendingFixups.filter(f => f.chatId === id);
    if (!mine.length) return;
    s.pendingFixups = s.pendingFixups.filter(f => f.chatId !== id);
    save();
    const chat = ctx().chat;
    let applied = 0;
    const touched = new Set();
    for (const f of mine) {
        const idx = chat[f.mesId] && replaceEverywhere(chat[f.mesId], f.find, f.replacement)
            ? f.mesId
            : chat.findIndex(m => replaceEverywhere(m, f.find, f.replacement));
        if (idx >= 0) { applied++; touched.add(idx); }
    }
    if (applied) {
        await ctx().saveChat();
        for (const idx of touched) rerender(idx);
        toast.success(`Applied ${applied} image${applied > 1 ? 's' : ''} that finished while you were away`);
    }
}

function rawRerender(mesId) {
    const c = ctx();
    const msg = c.chat[mesId];
    if (!msg || !mesEl(mesId)) return false;
    try {
        c.updateMessageBlock(mesId, msg);
        return true;
    } catch (e) {
        log('warn', `updateMessageBlock failed: ${e.message}`);
        return false;
    }
}

function rerender(mesId) {
    if (rawRerender(mesId)) {
        reattach(mesId);
        decorateMessage(mesId);
    }
}

// ---------------------------------------------------------------- placeholders

function placeholder(job) {
    const ar = String(job.meta.aspectRatio || '1:1').replace(':', ' / ');
    const el = h('div.iig-ph', { dataset: { job: job.id }, style: { aspectRatio: ar }, role: 'status', 'aria-live': 'polite' },
        h('div.iig-ph-shimmer'),
        h('div.iig-ph-body', {},
            h('div.iig-ph-icon', {}, h('span.iig-ph-ring', { 'aria-hidden': 'true' }), icon(job.kind === 'video' ? 'film' : 'wand-magic-sparkles')),
            h('div.iig-ph-status', {}, job.statusText),
            h('div.iig-ph-time', {}),
            job.prompt ? h('div.iig-ph-prompt', { title: job.prompt }, job.prompt) : null,
            h('div.iig-ph-actions', {},
                h('button.iig-ph-btn', { type: 'button', title: 'Cancel', dataset: { act: 'cancel' } }, icon('xmark'), h('span', {}, 'Cancel')),
            ),
        ),
        h('div.iig-ph-bar', { 'aria-hidden': 'true' }),
    );
    paintPlaceholder(el, job);
    return el;
}

function paintPlaceholder(el, job) {
    el.classList.toggle('is-error', job.status === 'error');
    el.classList.toggle('is-queued', job.status === 'queued');
    const status = el.querySelector('.iig-ph-status');
    const time = el.querySelector('.iig-ph-time');
    const actions = el.querySelector('.iig-ph-actions');
    if (job.status === 'error') {
        el.querySelector('.iig-ph-icon').replaceChildren(icon('triangle-exclamation'));
        status.textContent = job.error || 'Failed';
        time.textContent = hintFor({ message: job.error }) || '';
        actions.replaceChildren(
            h('button.iig-ph-btn', { type: 'button', dataset: { act: 'retry' } }, icon('rotate-right'), h('span', {}, 'Retry')),
            h('button.iig-ph-btn', { type: 'button', dataset: { act: 'edit' } }, icon('pen'), h('span', {}, 'Edit')),
            h('button.iig-ph-btn', { type: 'button', dataset: { act: 'diagnose' }, title: 'Find out why it failed' }, icon('stethoscope'), h('span', {}, 'Why?')),
        );
    } else {
        status.textContent = job.statusText;
        time.textContent = job.startedAt ? fmtElapsed(Date.now() - job.startedAt) : '';
    }
}

/** Keep every placeholder in the document in sync with its job. */
function syncPlaceholders(job) {
    if (!job) return;
    for (const el of document.querySelectorAll(`.iig-ph[data-job="${job.id}"]`)) paintPlaceholder(el, job);
}

setInterval(() => {
    for (const el of document.querySelectorAll('.iig-ph[data-job]:not(.is-error)')) {
        const job = queue.getJob(el.dataset.job);
        if (job?.startedAt && job.status === 'running') el.querySelector('.iig-ph-time').textContent = fmtElapsed(Date.now() - job.startedAt);
    }
}, 1000);

/** DOM <img>/<video> in a message that corresponds to `tag` (pending or a given src). */
function findDomFor(root, tag, { claimed = new Set() } = {}) {
    if (!root) return null;
    const attr = tag.kind === 'video' ? 'data-iig-video' : 'data-iig-instruction';
    const els = [...root.querySelectorAll(`[${attr}]`)].filter(e => !claimed.has(e) && !e.closest('.iig-ph'));
    const prompt = tag.data.prompt;
    const sameSrc = (e) => {
        const src = e.getAttribute('src') || '';
        if (tag.state === 'pending') return !src || /\[(IMG|VID):/.test(src) || src === '#';
        return src === tag.src || decodeURI(src) === decodeURI(tag.src);
    };
    const promptOf = (e) => { try { return parseInstruction(e.getAttribute(attr)).prompt; } catch { return null; } };
    return els.find(e => sameSrc(e) && promptOf(e) === prompt) || els.find(sameSrc) || null;
}

function attach(mesId, tag, job, claimed) {
    const root = mesTextEl(mesId);
    if (!root || root.querySelector(`.iig-ph[data-job="${job.id}"]`)) return;
    const target = findDomFor(root, tag, { claimed });
    const ph = placeholder(job);
    if (target) {
        claimed?.add(target);
        target.replaceWith(ph);
    } else if (tag.format === 'legacy' || tag.state === 'pending') {
        root.append(ph);
    }
}

/** Re-attach placeholders for jobs whose message was just re-rendered by ST. */
export function reattach(mesId) {
    const id = chatId();
    const msg = ctx().chat?.[mesId];
    if (!msg) return;
    const claimed = new Set();
    for (const [key, jobId] of inflight) {
        const [c, m] = key.split('|');
        if (c !== id || Number(m) !== Number(mesId)) continue;
        const job = queue.getJob(jobId);
        if (!job || !['queued', 'running', 'error'].includes(job.status)) continue;
        const tag = parseTags(msg.mes).find(t => t.fullMatch === job.meta.find);
        if (tag) attach(mesId, tag, job, claimed);
    }
}

/** Put a finished tag into the DOM in place of its placeholder (keeps interactive HTML state). */
function swapIn(job, newTagHtml, mesId) {
    const phs = document.querySelectorAll(`.iig-ph[data-job="${job.id}"]`);
    if (!phs.length) {
        if (mesId != null) rerender(mesId);
        return;
    }
    for (const ph of phs) {
        const tpl = document.createElement('template');
        tpl.innerHTML = newTagHtml;
        const el = tpl.content.firstElementChild;
        if (el) ph.replaceWith(el);
    }
    if (mesId != null) decorateMessage(mesId);
}

// ---------------------------------------------------------------- jobs from tags

function notifyDone(job, path) {
    const s = settings();
    if (s.haptics) haptic(25);
    if (s.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(job.kind === 'video' ? 'Video ready' : 'Image ready', { body: job.prompt.slice(0, 120), icon: job.kind === 'image' ? path : undefined, tag: job.id }); } catch { /* ignore */ }
    }
}

/**
 * Queue generation for one tag of message `mesId`.
 * mode 'new'   — tag is pending/error: on failure the tag gets the error image.
 * mode 'regen' — tag already has an image: on failure the old image is kept.
 * `dataOverride` replaces the instruction (Edit & regenerate).
 */
export function queueTag(mesId, tag, { mode = 'new', dataOverride = null, early = false } = {}) {
    const forChat = chatId();
    const key = `${forChat}|${mesId}|${tag.fullMatch}`;
    const existing = inflight.get(key);
    if (existing) {
        const j = queue.getJob(existing);
        if (j && ['queued', 'running'].includes(j.status)) return j;
    }
    const data = dataOverride ? { ...tag.data, ...dataOverride } : tag.data;
    let find = tag.fullMatch;
    // Started mid-stream: ST rewrites the message on every token, so wait for the final text before editing it.
    const streamDone = early ? streams.get(Number(mesId))?.done : null;

    const job = queue.enqueue({
        kind: tag.kind,
        prompt: data.prompt,
        meta: { chatId: forChat, mesId, aspectRatio: data.aspect_ratio || (tag.kind === 'video' ? '16:9' : settings().aspectRatio), find, mode, source: 'chat' },
    }, async (j, signal, setStatus) => {
        try {
            const res = await generate(tag.kind, data, { signal, setStatus });
            if (streamDone) { setStatus('Waiting for the reply to finish…'); await streamDone; }
            let next = withSrc({ ...tag, fullMatch: find }, res.path);
            if (dataOverride) next = withData(parseTags(next)[0] || { ...tag, fullMatch: next }, data);
            const { mesId: where } = await applyEdit(forChat, mesId, find, next);
            inflight.delete(key);
            if (forChat === chatId()) swapIn(j, next, where);
            notifyDone(j, res.path);
            return { ...res, mesId: where };
        } catch (e) {
            if (streamDone) await streamDone;
            const cancelled = isAbort(e);
            if (mode === 'regen') {
                // Never destroy a good image: put the original back.
                inflight.delete(key);
                if (forChat === chatId()) swapIn(j, find, mesId);
                if (!cancelled) toast.error(`Regenerate failed: ${e.message}`);
            } else if (!cancelled) {
                // Mark the tag failed in the source so reloads do not loop on it.
                const failed = withSrc({ ...tag, fullMatch: find }, errorSrc());
                if (failed !== find) {
                    await applyEdit(forChat, mesId, find, failed);
                    find = failed;
                    j.meta.find = failed;
                    const newKey = `${forChat}|${mesId}|${failed}`;
                    inflight.delete(key);
                    inflight.set(newKey, j.id);
                }
                if (settings().haptics) haptic([40, 60, 40]);
                const hint = hintFor(e);
                if (e.config) toast.warn(e.message);
                else toast.error(`${escapeHtml(e.message)}${hint ? `<br><small>${escapeHtml(hint)}</small>` : ''}`, { escapeHtml: false });
            } else {
                inflight.delete(key);
                if (forChat === chatId()) swapIn(j, find, mesId);
            }
            throw e;
        }
    });
    inflight.set(key, job.id);
    if (!early) attach(mesId, tag, job);
    return job;
}

// ---------------------------------------------------------------- streaming
//
// Images start as soon as their tag is complete in the streamed text, instead
// of after the whole reply. The placeholder appears when the reply renders.

const streams = new Map(); // mesId -> { done: Promise, resolve }
let generating = null; // { type, at } while ST writes a normal reply
let lastReplyAt = 0;

function settleStream(mesId) {
    const st = streams.get(Number(mesId));
    if (!st) return;
    streams.delete(Number(mesId));
    st.resolve();
}

export function onGenerationStarted(type, opts, dryRun) {
    // Quiet prompts (ours included) and impersonation don't write a chat reply.
    generating = dryRun || opts?.quiet_prompt || ['quiet', 'impersonate'].includes(type) ? null : { type, at: Date.now() };
    if (generating) lastReplyAt = Date.now();
}

export function onGenerationEnded() {
    generating = null;
    // Normally the render event settles streams; this covers stops and odd paths.
    for (const id of [...streams.keys()]) setTimeout(() => settleStream(id), 2000);
}

const TAG_HINT = /data-iig-(instruction|video)|\[(IMG|VID):GEN/;

export function onStreamToken(text) {
    const s = settings();
    if (!s.enabled || !s.autoGenerate || !s.earlyStart || !generating) return;
    const str = String(text || '');
    if (!TAG_HINT.test(str)) return;
    const chat = ctx().chat || [];
    const mesId = chat.length - 1;
    const msg = chat[mesId];
    if (!msg || msg.is_user || msg.is_system) return;
    const forChat = chatId();
    for (const tag of parseTags(str).filter(t => t.state === 'pending')) {
        if (inflight.has(`${forChat}|${mesId}|${tag.fullMatch}`)) continue;
        if (!streams.has(mesId)) {
            let resolve;
            const done = new Promise(r => { resolve = r; });
            streams.set(mesId, { done, resolve });
        }
        log('info', `Message ${mesId}: starting an image while the reply streams`);
        queueTag(mesId, tag, { early: true });
    }
}

/**
 * Auto-illustrate: after every Nth AI reply in a row without an image, have
 * the chat model write a prompt for it. Only for replies that were just
 * generated (not old messages being re-rendered).
 */
function maybeAutoIllustrate(mesId) {
    const s = settings();
    const every = Number(s.autoIllustrate) || 0;
    if (every <= 0 || !s.autoGenerate || Date.now() - lastReplyAt > 10 * 60 * 1000) return;
    const chat = ctx().chat || [];
    if (Number(mesId) !== chat.length - 1) return;
    let run = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m.is_system) continue;
        if (m.is_user) continue;
        if (parseTags(m.mes).length) break;
        run++;
    }
    if (run < every) return;
    lastReplyAt = 0; // once per reply
    illustrateMessage(Number(mesId)).catch(e => toast.error(`Auto-illustrate: ${e.message}`));
}

/**
 * Convert image requests written in other formats (capture rules) into tags,
 * in the message source. Returns true if the message changed.
 */
export function captureMessage(mesId) {
    const rules = settings().captureRules?.filter(r => r.enabled);
    const msg = ctx().chat?.[mesId];
    if (!rules?.length || !msg?.mes) return false;
    const before = msg.mes;
    const { text, captured, errors } = applyCapture(before, rules);
    for (const e of errors) log('warn', `Capture rule "${e.rule}" is invalid: ${e.error}`);
    if (!captured.length) return false;
    msg.mes = text;
    if (Array.isArray(msg.swipes) && Number.isInteger(msg.swipe_id) && msg.swipes[msg.swipe_id] === before) msg.swipes[msg.swipe_id] = text;
    if (msg.extra?.display_text) msg.extra.display_text = applyCapture(msg.extra.display_text, rules).text;
    log('info', `Message ${mesId}: captured ${captured.length} prompt(s) via ${[...new Set(captured.map(c => c.rule))].join(', ')}`);
    ctx().saveChat();
    rawRerender(mesId);
    return true;
}

/**
 * Generate every pending tag in a message. Called after each AI message renders,
 * after the user's own messages when "Process image tags in my messages" is on,
 * and by other extensions through window.RevampedImageGen.processMessage.
 */
export function processMessage(mesId, { force = false } = {}) {
    const s = settings();
    if (!s.enabled) return [];
    const msg = ctx().chat?.[mesId];
    if (!msg || msg.is_system) return [];
    settleStream(mesId);
    if (!msg.is_user || s.processUserMessages) captureMessage(mesId);
    const pending = parseTags(msg.mes).filter(t => t.state === 'pending');
    reattach(mesId);
    if (!pending.length || (!s.autoGenerate && !force)) {
        decorateMessage(mesId);
        if (!pending.length && !msg.is_user && !force) maybeAutoIllustrate(mesId);
        return [];
    }
    // "Tap to generate" cards replaced the pending <img>s; restore them so placeholders land in place.
    if (mesTextEl(mesId)?.querySelector('.iig-ph-idle')) {
        rawRerender(mesId);
        reattach(mesId);
    }
    log('info', `Message ${mesId}: ${pending.length} pending tag(s)`);
    const claimed = new Set();
    const jobs = pending.map(t => {
        const job = queueTag(mesId, t);
        attach(mesId, t, job, claimed);
        return job;
    });
    decorateMessage(mesId);
    return jobs;
}

/** Regenerate all media in a message (existing images are kept if a job fails). */
export function regenerateMessage(mesId) {
    const msg = ctx().chat?.[mesId];
    if (!msg) return [];
    const tags = parseTags(msg.mes);
    if (!tags.length) {
        toast.info('No image tags in this message');
        return [];
    }
    return tags.map(t => queueTag(mesId, t, { mode: t.state === 'done' ? 'regen' : 'new' }));
}

/** Find the tag behind a rendered element (img/video/error image) in a message. */
export function tagForElement(el) {
    const mes = el.closest('.mes');
    if (!mes) return null;
    const mesId = Number(mes.getAttribute('mesid'));
    const msg = ctx().chat?.[mesId];
    if (!msg) return null;
    const src = el.getAttribute('src') || el.dataset.src || '';
    const attrName = el.hasAttribute('data-iig-video') ? 'data-iig-video' : 'data-iig-instruction';
    let prompt = null;
    try { prompt = parseInstruction(el.getAttribute(attrName) || '').prompt; } catch { /* ignore */ }
    const tags = parseTags(msg.mes);
    const tag = tags.find(t => t.src === src && (prompt == null || t.data.prompt === prompt))
        || tags.find(t => t.src && decodeURI(t.src) === decodeURI(src))
        || tags.find(t => prompt != null && t.data.prompt === prompt);
    return tag ? { mesId, tag } : null;
}

/** Regenerate the media behind a rendered element; `dataOverride` for edited prompts. */
export function regenerateElement(el, dataOverride = null) {
    const found = tagForElement(el);
    if (!found) {
        toast.warn('Could not find this image in the message source.');
        return null;
    }
    const { mesId, tag } = found;
    const mode = tag.state === 'done' ? 'regen' : 'new';
    const job = queueTag(mesId, tag, { mode, dataOverride });
    const target = el.closest('.iig-media') || el;
    if (target.isConnected && !document.querySelector(`.iig-ph[data-job="${job.id}"]`)) target.replaceWith(placeholder(job));
    return job;
}

/** Regenerate the finished media with `src` in message `mesId` (works even if not rendered). */
export function regenerateBySrc(mesId, src, dataOverride = null) {
    const msg = ctx().chat?.[mesId];
    const tag = msg && parseTags(msg.mes).find(t => t.src === src);
    if (!tag) {
        toast.warn('Could not find this image in the message source.');
        return null;
    }
    return queueTag(mesId, tag, { mode: tag.state === 'done' ? 'regen' : 'new', dataOverride });
}

/** Remove a finished tag from its message and delete the file. */
export async function removeMedia(mesId, src, deleteFn) {
    const msg = ctx().chat?.[mesId];
    const tag = msg && parseTags(msg.mes).find(t => t.src === src);
    if (!tag) return false;
    await applyEdit(chatId(), mesId, tag.fullMatch, '');
    rerender(mesId);
    if (deleteFn) await deleteFn(src);
    return true;
}

/** Scroll a message into view and flash it. */
export function jumpToMessage(mesId) {
    const el = mesEl(mesId);
    if (!el) {
        toast.info('That message is not loaded — scroll up and tap "Show more messages".');
        return false;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('iig-flash');
    setTimeout(() => el.classList.remove('iig-flash'), 1600);
    return true;
}

// ---------------------------------------------------------------- inserting new media

/** Append a finished image (e.g. from the studio) to a message. */
export async function insertIntoMessage(mesId, { kind = 'image', data, path }) {
    const c = ctx();
    const msg = c.chat?.[mesId];
    if (!msg) throw new Error('Message not found');
    const tag = buildTag(kind, data, path);
    msg.mes = `${msg.mes || ''}\n\n${tag}`;
    if (Array.isArray(msg.swipes) && Number.isInteger(msg.swipe_id)) msg.swipes[msg.swipe_id] = msg.mes;
    await c.saveChat();
    rerender(mesId);
}

/** Last message suitable for attaching media (prefers the latest AI message). */
export function lastMessageId({ aiOnly = false } = {}) {
    const chat = ctx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_system) continue;
        if (aiOnly && chat[i].is_user) continue;
        return i;
    }
    return null;
}

/** Ask the chat model for a scene prompt, append a pending tag, then generate it. */
export async function illustrateMessage(mesId) {
    const s = settings();
    const id = mesId ?? lastMessageId();
    if (id == null) throw new Error('No message to illustrate');
    const forChat = chatId();
    // Shown in the message while the chat model writes the prompt.
    const writing = h('div.iig-ph.iig-ph-writing', { role: 'status', 'aria-live': 'polite', style: { aspectRatio: String(s.aspectRatio || '1:1').replace(':', ' / ') } },
        h('div.iig-ph-shimmer'),
        h('div.iig-ph-body', {},
            h('div.iig-ph-icon', {}, h('span.iig-ph-ring', { 'aria-hidden': 'true' }), icon('feather')),
            h('div.iig-ph-status', {}, 'Writing a prompt for this scene…'),
        ));
    mesTextEl(id)?.append(writing);
    let prompt;
    try {
        prompt = await describeScene(id);
    } finally {
        writing.remove();
    }
    if (forChat !== chatId()) throw new Error('The chat changed while the prompt was being written.');
    const c = ctx();
    const msg = c.chat[id];
    if (!msg) throw new Error('That message is gone.');
    const data = { prompt, aspect_ratio: s.aspectRatio };
    if (s.imageSize && s.imageSize !== 'auto') data.image_size = s.imageSize;
    if (s.defaultStyle) data.style = s.defaultStyle;
    msg.mes = `${msg.mes || ''}\n\n${buildTag('image', data, '[IMG:GEN]')}`;
    if (Array.isArray(msg.swipes) && Number.isInteger(msg.swipe_id)) msg.swipes[msg.swipe_id] = msg.mes;
    await c.saveChat();
    rerender(id);
    return processMessage(id, { force: true });
}

// ---------------------------------------------------------------- decoration

/**
 * Post-render touch-ups for a message: mark our media, turn reloaded video
 * tags into <video>, show "tap to generate" cards when auto-generate is off,
 * and add the per-message buttons.
 */
export function decorateMessage(mesId) {
    const el = mesEl(mesId);
    if (!el) return;
    const root = el.querySelector('.mes_text');
    if (root) decorateMedia(root, mesId);
    addMessageButtons(el);
}

export function decorateMedia(root, mesId) {
    for (const img of root.querySelectorAll('img[data-iig-instruction], img[data-iig-video]')) {
        const src = img.getAttribute('src') || '';
        const isVideo = img.hasAttribute('data-iig-video');
        img.classList.remove('iig-img', 'iig-img-error', 'iig-img-pending');
        if (/error\.svg/i.test(src)) {
            img.classList.add('iig-img-error');
            img.title = 'Generation failed — tap for options';
        } else if (!src || /\[(IMG|VID):/.test(src)) {
            img.classList.add('iig-img-pending');
            // Not running (auto-generate off, or an old message from a reloaded chat): offer a button.
            if (mesId != null) {
                const btn = h('button.iig-ph.iig-ph-idle', { type: 'button', dataset: { mes: mesId } },
                    h('div.iig-ph-body', {}, icon(isVideo ? 'film' : 'image'), h('div.iig-ph-status', {}, 'Tap to generate')));
                img.replaceWith(btn);
            }
        } else if (isVideo) {
            const video = h('video.iig-video', {
                src, controls: true, playsInline: true, loop: true, preload: 'metadata',
                dataset: { iigVideo: img.getAttribute('data-iig-video'), src },
            });
            video.setAttribute('playsinline', '');
            video.setAttribute('data-iig-video', img.getAttribute('data-iig-video'));
            img.replaceWith(video);
        } else {
            img.classList.add('iig-img');
            img.loading = 'lazy';
            img.decoding = 'async';
            if (!img.alt) {
                try { img.alt = parseInstruction(img.getAttribute('data-iig-instruction')).prompt.slice(0, 200); } catch { /* ignore */ }
            }
        }
    }
}

function addMessageButtons(mes) {
    const extra = mes.querySelector('.extraMesButtons');
    if (!extra) return;
    if (!extra.querySelector('.iig-mes-illustrate')) {
        extra.prepend(
            h('div.mes_button.iig-mes-illustrate.fa-solid.fa-wand-magic-sparkles', { title: 'Illustrate this message', tabindex: '0', role: 'button' }),
            h('div.mes_button.iig-mes-regen.fa-solid.fa-images', { title: 'Regenerate images in this message', tabindex: '0', role: 'button' }),
        );
    }
    const msg = ctx().chat?.[Number(mes.getAttribute('mesid'))];
    extra.querySelector('.iig-mes-regen').style.display = msg && parseTags(msg.mes).length ? '' : 'none';
}

export function decorateAll() {
    for (const mes of document.querySelectorAll('#chat .mes[mesid]')) {
        decorateMessage(Number(mes.getAttribute('mesid')));
        reattach(Number(mes.getAttribute('mesid')));
    }
}

/** Every finished image/video in the open chat, newest first (for the gallery). */
export function chatMedia() {
    const chat = ctx().chat || [];
    const out = [];
    chat.forEach((m, mesId) => {
        if (!m?.mes) return;
        for (const t of parseTags(m.mes)) {
            if (t.state !== 'done') continue;
            out.push({ src: t.src, kind: t.kind, prompt: t.data.prompt, data: t.data, mesId, name: m.name, source: 'chat' });
        }
    });
    return out.reverse();
}

// ---------------------------------------------------------------- delegated events

export function installChatHandlers({ openViewer, openEditor, openDiagnose }) {
    queue.onQueue(syncPlaceholders);
    const chatRoot = document.getElementById('chat') || document.body;

    chatRoot.addEventListener('click', (e) => {
        const t = e.target;
        const phBtn = t.closest('.iig-ph [data-act]');
        if (phBtn) {
            e.preventDefault();
            e.stopPropagation();
            const ph = phBtn.closest('.iig-ph');
            const job = queue.getJob(ph.dataset.job);
            if (!job) return;
            if (phBtn.dataset.act === 'cancel') queue.cancel(job.id);
            if (phBtn.dataset.act === 'retry') queue.retry(job.id);
            if (phBtn.dataset.act === 'diagnose') openDiagnose?.();
            if (phBtn.dataset.act === 'edit') {
                openEditor({
                    title: 'Edit & retry',
                    data: currentDataFor(job),
                    kind: job.kind,
                    onSubmit: (data) => {
                        const found = findTagForJob(job);
                        if (found) { ph.remove(); queueTag(found.mesId, found.tag, { dataOverride: data }); }
                    },
                });
            }
            return;
        }
        const idle = t.closest('.iig-ph-idle');
        if (idle) {
            e.preventDefault();
            processMessage(Number(idle.dataset.mes), { force: true });
            return;
        }
        if (t.closest('.iig-mes-illustrate')) {
            const mesId = Number(t.closest('.mes').getAttribute('mesid'));
            illustrateMessage(mesId).catch(err => toast.error(err.message));
            return;
        }
        if (t.closest('.iig-mes-regen')) {
            regenerateMessage(Number(t.closest('.mes').getAttribute('mesid')));
            return;
        }
        const media = t.closest('.mes_text img.iig-img, .mes_text img.iig-img-error');
        // Images inside interactive HTML (labels, links, <details>) keep their own click
        // behaviour; those open the viewer via long-press or the hover toolbar instead.
        if (media && !media.closest('label, a, button, summary, [onclick]')) {
            e.preventDefault();
            openViewer(media);
        }
    });
}

function findTagForJob(job) {
    const chat = ctx().chat || [];
    const m = job.meta;
    const inMsg = (i) => parseTags(chat[i]?.mes || '').find(t => t.fullMatch === m.find);
    let tag = inMsg(m.mesId);
    if (tag) return { mesId: m.mesId, tag };
    for (let i = chat.length - 1; i >= 0; i--) {
        tag = inMsg(i);
        if (tag) return { mesId: i, tag };
    }
    return null;
}

function currentDataFor(job) {
    return findTagForJob(job)?.tag.data || { prompt: job.prompt };
}
