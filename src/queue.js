/*
 * Revamped Image Gen — job queue with a concurrency limit.
 *
 * notsosillynotsoimages fires every tag in a message at once; providers then
 * rate-limit and everything fails together. Here jobs wait for a slot, can be
 * cancelled or retried individually, and the UI subscribes to live state.
 * Licensed under AGPL-3.0-or-later.
 */

import { settings } from './settings.js';
import { isAbort, log, uid } from './st.js';

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {'image'|'video'} kind
 * @property {string} prompt
 * @property {string} title          short label for lists
 * @property {'queued'|'running'|'done'|'error'|'cancelled'} status
 * @property {string} statusText
 * @property {number} createdAt
 * @property {number|null} startedAt
 * @property {number|null} finishedAt
 * @property {string|null} error
 * @property {object|null} result    { path, ... } on success
 * @property {object} meta           caller data (chatId, messageId, aspectRatio…)
 */

const jobs = new Map();
const order = [];
const listeners = new Set();
const runners = new Map();      // id -> async (job, signal, setStatus) => result
const controllers = new Map();  // id -> AbortController
const waiters = new Map();      // id -> [{resolve, reject}]
let running = 0;
const HISTORY = 60;

function emit(job) {
    for (const fn of listeners) {
        try { fn(job); } catch (e) { log('warn', 'queue listener failed', e); }
    }
}

export function onQueue(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function allJobs() {
    return order.map(id => jobs.get(id)).filter(Boolean);
}

export function getJob(id) {
    return jobs.get(id) || null;
}

export function activeCount() {
    let n = 0;
    for (const j of jobs.values()) if (j.status === 'queued' || j.status === 'running') n++;
    return n;
}

function update(job, patch) {
    Object.assign(job, patch);
    emit(job);
}

function prune() {
    while (order.length > HISTORY) {
        const idx = order.findIndex(id => !['queued', 'running'].includes(jobs.get(id)?.status));
        if (idx === -1) break;
        const [id] = order.splice(idx, 1);
        jobs.delete(id);
        runners.delete(id);
    }
}

/**
 * Queue a job. `run(job, signal, setStatus)` does the work and returns the result.
 * Returns the job; `waitFor(job.id)` resolves with its result.
 */
export function enqueue({ kind = 'image', prompt = '', title, meta = {} }, run) {
    const job = {
        id: uid('job'),
        kind,
        prompt,
        title: title || prompt.slice(0, 80) || '(no prompt)',
        status: 'queued',
        statusText: 'Waiting for a free slot…',
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        error: null,
        result: null,
        attempts: 0,
        meta,
    };
    jobs.set(job.id, job);
    order.push(job.id);
    runners.set(job.id, run);
    prune();
    emit(job);
    pump();
    return job;
}

export function waitFor(id) {
    const job = jobs.get(id);
    if (!job) return Promise.reject(new Error('Unknown job'));
    if (job.status === 'done') return Promise.resolve(job.result);
    if (job.status === 'error') return Promise.reject(new Error(job.error));
    if (job.status === 'cancelled') return Promise.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    return new Promise((resolve, reject) => {
        if (!waiters.has(id)) waiters.set(id, []);
        waiters.get(id).push({ resolve, reject });
    });
}

function settle(job, err) {
    const list = waiters.get(job.id) || [];
    waiters.delete(job.id);
    for (const w of list) err ? w.reject(err) : w.resolve(job.result);
}

function pump() {
    const limit = Math.max(1, Number(settings().concurrency) || 1);
    while (running < limit) {
        const next = order.map(id => jobs.get(id)).find(j => j?.status === 'queued');
        if (!next) return;
        start(next);
    }
}

async function start(job) {
    running++;
    const controller = new AbortController();
    controllers.set(job.id, controller);
    update(job, { status: 'running', statusText: 'Starting…', startedAt: Date.now(), attempts: job.attempts + 1, error: null });
    const setStatus = (text) => { if (job.status === 'running') update(job, { statusText: text }); };
    try {
        const result = await runners.get(job.id)(job, controller.signal, setStatus);
        update(job, { status: 'done', statusText: 'Done', result, finishedAt: Date.now() });
        settle(job);
    } catch (e) {
        if (isAbort(e) || controller.signal.aborted) {
            update(job, { status: 'cancelled', statusText: 'Cancelled', finishedAt: Date.now() });
            settle(job, Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
        } else {
            log('error', `Job failed: ${e.message}`);
            update(job, { status: 'error', statusText: 'Failed', error: e.message || String(e), finishedAt: Date.now() });
            settle(job, e);
        }
    } finally {
        controllers.delete(job.id);
        running--;
        pump();
    }
}

export function cancel(id) {
    const job = jobs.get(id);
    if (!job) return;
    if (job.status === 'queued') {
        update(job, { status: 'cancelled', statusText: 'Cancelled', finishedAt: Date.now() });
        settle(job, Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    } else if (job.status === 'running') {
        controllers.get(id)?.abort('user-cancel');
    }
}

export function cancelAll(filter = () => true) {
    for (const j of allJobs()) if ((j.status === 'queued' || j.status === 'running') && filter(j)) cancel(j.id);
}

/** Re-run a failed/cancelled job with the same runner. */
export function retry(id) {
    const job = jobs.get(id);
    if (!job || !runners.has(id) || job.status === 'queued' || job.status === 'running') return false;
    update(job, { status: 'queued', statusText: 'Waiting for a free slot…', error: null, result: null, finishedAt: null });
    pump();
    return true;
}

export function clearFinished() {
    for (let i = order.length - 1; i >= 0; i--) {
        const j = jobs.get(order[i]);
        if (j && !['queued', 'running'].includes(j.status)) {
            jobs.delete(j.id);
            runners.delete(j.id);
            order.splice(i, 1);
        }
    }
    emit(null);
}

// ---------------------------------------------------------------- wake lock

let wakeLock = null;

async function syncWakeLock() {
    const want = settings().wakeLock && activeCount() > 0 && !document.hidden;
    try {
        if (want && !wakeLock && 'wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        } else if (!want && wakeLock) {
            await wakeLock.release();
            wakeLock = null;
        }
    } catch {
        wakeLock = null; // denied or unsupported; harmless
    }
}

/** Keep the phone screen awake while jobs run, so the OS does not suspend the tab mid-request. */
export function installWakeLock() {
    onQueue(() => syncWakeLock());
    document.addEventListener('visibilitychange', () => syncWakeLock());
}
