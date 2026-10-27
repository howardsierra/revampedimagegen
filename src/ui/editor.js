/*
 * Revamped Image Gen — prompt editor modal (Edit & regenerate, Remix).
 * Renders as a bottom sheet on phones and a centred dialog elsewhere.
 * Licensed under AGPL-3.0-or-later.
 */

import { ASPECT_RATIOS, VIDEO_RESOLUTIONS } from '../constants.js';
import { settings } from '../settings.js';
import { h, icon, chipSelect, field } from './dom.js';
import { ratioChip, sizeChips } from './widgets.js';

/**
 * @param {{title?:string, kind?:'image'|'video', data:object, submitLabel?:string, onSubmit:(data)=>void}} opts
 */
export function openEditor({ title = 'Edit prompt', kind = 'image', data = {}, submitLabel = 'Generate', onSubmit }) {
    const s = settings();
    const state = { ...data };
    const lastFocus = document.activeElement;

    const prompt = h('textarea.iig-input.iig-prompt', { rows: 6, value: state.prompt || '', placeholder: 'Describe the image…', oninput: () => { state.prompt = prompt.value; } });
    const style = h('input.iig-input', { type: 'text', value: state.style || '', placeholder: 'Style (optional)', list: 'iig-style-list', oninput: () => { state.style = style.value; } });
    const styleChips = h('div.iig-chips.iig-chips-scroll', {}, (s.styles || []).map(st => h('button.iig-chip', {
        type: 'button', title: st.value, onclick: () => { style.value = st.value; state.style = st.value; },
    }, st.name)));
    const ar = chipSelect(ASPECT_RATIOS.map(r => ({ value: r, label: r })), state.aspect_ratio || s.aspectRatio, v => { state.aspect_ratio = v; }, { className: 'iig-chips-scroll', render: ratioChip });

    const extra = [];
    if (kind === 'video') {
        const dur = h('input.iig-input', { type: 'number', min: 1, max: 30, value: state.duration ?? s.videoDuration, oninput: () => { state.duration = Number(dur.value) || undefined; } });
        const res = chipSelect(VIDEO_RESOLUTIONS, state.resolution || s.videoResolution, v => { state.resolution = v; });
        extra.push(field('Duration (s)', dur), field('Resolution', res.el));
    } else {
        const size = sizeChips(state.image_size || s.imageSize || 'auto', v => { state.image_size = v; });
        extra.push(field('Resolution', size.el));
    }
    const negative = h('input.iig-input', { type: 'text', value: state.negative_prompt || '', placeholder: 'Things to avoid (if supported)', oninput: () => { state.negative_prompt = negative.value; } });
    const seed = h('input.iig-input', { type: 'number', value: state.seed ?? '', placeholder: 'Random', oninput: () => { state.seed = seed.value === '' ? undefined : Number(seed.value); } });

    const submit = () => {
        if (!String(state.prompt || '').trim()) {
            prompt.focus();
            prompt.classList.add('iig-shake');
            setTimeout(() => prompt.classList.remove('iig-shake'), 400);
            return;
        }
        closeModal();
        const out = { ...state };
        for (const k of Object.keys(out)) if (out[k] === '' || out[k] === undefined) delete out[k];
        onSubmit(out);
    };

    const sheet = h('div.iig-modal-card', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div.iig-grab', { 'aria-hidden': 'true' }, h('span')),
        h('header.iig-modal-head', {}, h('h3', {}, title), h('button.iig-icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => closeModal() }, icon('xmark'))),
        h('div.iig-modal-body', {},
            field('Prompt', prompt),
            field('Style', h('div.iig-stack', {}, style, styleChips)),
            field('Aspect ratio', ar.el),
            ...extra,
            h('div.iig-row-2', {}, field('Negative', negative), field('Seed', seed)),
        ),
        h('footer.iig-modal-foot', {},
            h('button.iig-btn', { type: 'button', onclick: () => closeModal() }, 'Cancel'),
            h('button.iig-btn.primary', { type: 'button', onclick: submit }, icon(kind === 'video' ? 'film' : 'wand-magic-sparkles'), ` ${submitLabel}`),
        ),
    );
    const modal = h('div.iig-modal', { onclick: (e) => { if (e.target === modal) closeModal(); } }, sheet);
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
    });
    document.getElementById('iig-root').append(modal);
    requestAnimationFrame(() => {
        modal.classList.add('is-open');
        // Do not pop the keyboard on phones; the user can tap into the prompt.
        if (!matchMedia('(pointer: coarse)').matches) prompt.focus();
    });

    function closeModal() {
        modal.classList.remove('is-open');
        setTimeout(() => modal.remove(), 200);
        lastFocus?.focus?.();
    }
    return closeModal;
}

/** Simple confirm dialog styled like the editor. Resolves true/false. */
export function confirmDialog(message, { okLabel = 'OK', danger = false } = {}) {
    return new Promise((resolve) => {
        const done = (v) => {
            modal.classList.remove('is-open');
            setTimeout(() => modal.remove(), 200);
            resolve(v);
        };
        const modal = h('div.iig-modal.iig-modal-small', { onclick: (e) => { if (e.target === modal) done(false); } },
            h('div.iig-modal-card', { role: 'alertdialog', 'aria-modal': 'true' },
                h('div.iig-modal-body', {}, h('p', {}, message)),
                h('footer.iig-modal-foot', {},
                    h('button.iig-btn', { type: 'button', onclick: () => done(false) }, 'Cancel'),
                    h(`button.iig-btn.${danger ? 'danger' : 'primary'}`, { type: 'button', onclick: () => done(true) }, okLabel),
                ),
            ),
        );
        modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
        document.getElementById('iig-root').append(modal);
        requestAnimationFrame(() => { modal.classList.add('is-open'); modal.querySelector('.primary, .danger')?.focus(); });
    });
}
