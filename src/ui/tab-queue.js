/*
 * Revamped Image Gen — Queue tab: every running/finished job with live status,
 * cancel, retry and jump-to-message. Licensed under AGPL-3.0-or-later.
 */

import * as chat from '../chat.js';
import { hintFor } from '../engine.js';
import * as queue from '../queue.js';
import { chatId } from '../st.js';
import { chatItemActions, studioItemActions } from './actions.js';
import { fmtElapsed, fmtTime, h, icon } from './dom.js';
import { openViewer } from './viewer.js';
import { empty } from './widgets.js';

const STATUS_ICON = {
    queued: 'clock',
    running: 'spinner fa-spin',
    done: 'circle-check',
    error: 'triangle-exclamation',
    cancelled: 'ban',
};

export function createQueueTab() {
    const list = h('div.iig-jobs', { role: 'list' });
    const summary = h('span.iig-muted');
    const el = h('section', {},
        h('div.iig-row.between.iig-pad', {},
            summary,
            h('div.iig-row', {},
                h('button.iig-btn.small.ghost', { type: 'button', onclick: () => queue.cancelAll() }, icon('stop'), h('span', {}, 'Stop all')),
                h('button.iig-btn.small.ghost', { type: 'button', onclick: () => queue.clearFinished() }, icon('broom'), h('span', {}, 'Clear')),
            ),
        ),
        list,
    );

    const rows = new Map();
    let visible = false;

    function row(job) {
        const r = h('div.iig-job', { role: 'listitem', dataset: { id: job.id } },
            h('div.iig-job-icon'),
            h('div.iig-job-main', {},
                h('div.iig-job-title'),
                h('div.iig-job-meta'),
                h('div.iig-job-error'),
            ),
            h('div.iig-job-actions'),
        );
        rows.set(job.id, r);
        return r;
    }

    function paint(job, r) {
        r.dataset.status = job.status;
        r.querySelector('.iig-job-icon').replaceChildren(icon(job.kind === 'video' && job.status === 'done' ? 'film' : STATUS_ICON[job.status]));
        r.querySelector('.iig-job-title').textContent = job.title;
        const where = job.meta.source === 'studio' ? 'Studio' : `Message #${job.meta.mesId}`;
        const elsewhere = job.meta.chatId && job.meta.chatId !== chatId() ? ' · other chat' : '';
        const time = job.status === 'running' && job.startedAt
            ? fmtElapsed(Date.now() - job.startedAt)
            : job.finishedAt && job.startedAt ? `${fmtElapsed(job.finishedAt - job.startedAt)} · ${fmtTime(job.finishedAt)}` : fmtTime(job.createdAt);
        r.querySelector('.iig-job-meta').textContent = `${where}${elsewhere} · ${job.status === 'running' ? job.statusText : job.status} · ${time}`;
        const err = r.querySelector('.iig-job-error');
        if (job.status === 'error') {
            const hint = hintFor({ message: job.error });
            err.replaceChildren(...[h('span', {}, job.error), hint ? h('small', {}, hint) : null].filter(Boolean));
        } else err.replaceChildren();

        const acts = [];
        if (job.status === 'queued' || job.status === 'running') {
            acts.push(h('button.iig-icon-btn', { type: 'button', title: 'Cancel', 'aria-label': 'Cancel', onclick: () => queue.cancel(job.id) }, icon('xmark')));
        }
        if (job.status === 'error' || job.status === 'cancelled') {
            acts.push(h('button.iig-icon-btn', { type: 'button', title: 'Retry', 'aria-label': 'Retry', onclick: () => queue.retry(job.id) }, icon('rotate-right')));
        }
        const src = job.result?.src || job.result?.path;
        if (job.status === 'done' && src) {
            const isStudio = job.meta.source === 'studio';
            const item = isStudio ? job.result : { src, kind: job.kind, prompt: job.prompt, data: job.result.options ? { prompt: job.result.options.rawPrompt, style: job.result.options.style, aspect_ratio: job.result.options.aspectRatio } : null, mesId: job.result.mesId };
            const actions = isStudio ? studioItemActions : chatItemActions;
            acts.push(h('button.iig-icon-btn', { type: 'button', title: 'View', 'aria-label': 'View', onclick: () => openViewer([item], 0, actions) }, icon('eye')));
        }
        if (job.meta.source === 'chat' && job.meta.chatId === chatId()) {
            const mesId = job.result?.mesId ?? job.meta.mesId;
            acts.push(h('button.iig-icon-btn', { type: 'button', title: 'Go to message', 'aria-label': 'Go to message', onclick: () => chat.jumpToMessage(mesId) }, icon('location-crosshairs')));
        }
        r.querySelector('.iig-job-actions').replaceChildren(...acts);
    }

    function render() {
        const jobs = queue.allJobs().slice().reverse();
        const active = jobs.filter(j => j.status === 'queued' || j.status === 'running').length;
        const failed = jobs.filter(j => j.status === 'error').length;
        summary.textContent = jobs.length ? `${active} active · ${failed} failed · ${jobs.length} total` : '';
        if (!jobs.length) {
            rows.clear();
            list.replaceChildren(empty('list-check', 'Queue is empty', 'Images being generated from chat messages and the studio appear here.'));
            return;
        }
        const nodes = jobs.map(j => {
            const r = rows.get(j.id) || row(j);
            paint(j, r);
            return r;
        });
        for (const id of rows.keys()) if (!jobs.some(j => j.id === id)) rows.delete(id);
        list.replaceChildren(...nodes);
    }

    queue.onQueue((job) => {
        if (!visible) return;
        if (job && rows.has(job.id) && list.contains(rows.get(job.id))) paint(job, rows.get(job.id));
        else render();
    });
    setInterval(() => {
        if (!visible) return;
        for (const j of queue.allJobs()) if (j.status === 'running' && rows.has(j.id)) paint(j, rows.get(j.id));
    }, 1000);

    return {
        id: 'queue',
        label: 'Queue',
        icon: 'list-check',
        el,
        onShow: () => { visible = true; render(); },
        onHide: () => { visible = false; },
    };
}
