/*
 * Revamped Image Gen — Create tab: write (or have the chat model write) a
 * prompt, pick style/shape/size, see which references will be sent, generate.
 * Licensed under AGPL-3.0-or-later.
 */

import { ASPECT_RATIOS, IMAGE_SIZES } from '../constants.js';
import { describeScene } from '../prompt.js';
import { getProvider } from '../providers.js';
import * as queue from '../queue.js';
import { matchRefs } from '../refs.js';
import { onSettingsChange, save, settings } from '../settings.js';
import { onStudioChange, runStudio, studioHistory } from '../studio.js';
import { toast } from '../st.js';
import { studioItemActions } from './actions.js';
import { chipSelect, debounce, field, h, icon } from './dom.js';
import { openViewer } from './viewer.js';
import { empty, ratioChip, tile } from './widgets.js';

export function createTab({ show }) {
    const s = settings();
    const draft = s.studioDraft;
    const persist = debounce(() => save('studioDraft'), 300);
    const set = (k, v) => { draft[k] = v; persist(); };

    // --- prompt
    const prompt = h('textarea.iig-input.iig-prompt', {
        rows: 4,
        value: draft.prompt || '',
        placeholder: 'Describe what to draw. Use character names to attach their reference photos.',
        oninput: () => { set('prompt', prompt.value); updateRefs(); },
        onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go(); },
    });
    const sceneBtn = h('button.iig-btn.small', {
        type: 'button', title: 'Ask your chat model to write a prompt for the latest message',
        onclick: async () => {
            sceneBtn.disabled = true;
            sceneBtn.classList.add('is-busy');
            try {
                prompt.value = await describeScene();
                set('prompt', prompt.value);
                updateRefs();
            } catch (e) {
                toast.error(e.message);
            } finally {
                sceneBtn.disabled = false;
                sceneBtn.classList.remove('is-busy');
            }
        },
    }, icon('wand-magic-sparkles'), h('span', {}, 'From scene'));
    const clearBtn = h('button.iig-btn.small.ghost', { type: 'button', onclick: () => { prompt.value = ''; set('prompt', ''); updateRefs(); prompt.focus(); } }, icon('eraser'), h('span', {}, 'Clear'));

    // --- kind
    const kind = chipSelect([{ value: 'image', label: 'Image' }, { value: 'video', label: 'Video' }], draft.kind || 'image', v => { set('kind', v); syncKind(); });

    // --- style
    const style = h('input.iig-input', { type: 'text', value: draft.style || '', placeholder: s.defaultStyle ? `Default: ${s.defaultStyle}` : 'Optional', oninput: () => { set('style', style.value); markStyle(); } });
    const styleChips = h('div.iig-chips.iig-chips-scroll');
    const renderStyles = () => {
        styleChips.replaceChildren(...(settings().styles || []).map(st => h('button.iig-chip', {
            type: 'button', title: st.value, dataset: { value: st.value },
            onclick: () => {
                const v = style.value === st.value ? '' : st.value;
                style.value = v;
                set('style', v);
                markStyle();
            },
        }, st.name)));
        markStyle();
    };
    const markStyle = () => {
        for (const b of styleChips.children) b.classList.toggle('active', b.dataset.value === style.value);
    };

    // --- shape & size & count
    const ar = chipSelect(ASPECT_RATIOS.map(r => ({ value: r, label: r })), draft.aspect_ratio || s.aspectRatio, v => set('aspect_ratio', v), { className: 'iig-chips-scroll', render: ratioChip });
    const size = chipSelect(IMAGE_SIZES, draft.image_size || s.imageSize, v => set('image_size', v));
    const countLabel = h('span.iig-stepper-value', {}, String(draft.count || 1));
    const step = (d) => {
        const n = Math.min(4, Math.max(1, (Number(draft.count) || 1) + d));
        set('count', n);
        countLabel.textContent = String(n);
        goLabel.textContent = n > 1 ? `Generate ${n}` : 'Generate';
    };
    const stepper = h('div.iig-stepper', {},
        h('button.iig-icon-btn', { type: 'button', 'aria-label': 'Fewer', onclick: () => step(-1) }, icon('minus')),
        countLabel,
        h('button.iig-icon-btn', { type: 'button', 'aria-label': 'More', onclick: () => step(1) }, icon('plus')),
    );
    const sizeField = field('Resolution', size.el);

    // --- refs preview
    const refsLine = h('div.iig-refs-line');
    const useRefs = h('input', { type: 'checkbox', checked: draft.useRefs !== false, onchange: () => { set('useRefs', useRefs.checked); updateRefs(); } });
    const updateRefs = debounce(() => {
        const p = getProvider(settings().provider);
        const supports = draft.kind === 'video' || (p.supportsRefs && settings().sendRefs);
        if (!supports) {
            refsLine.replaceChildren(h('span.iig-muted', {}, `${p.label} does not use reference images.`));
            return;
        }
        const matched = useRefs.checked ? matchRefs(prompt.value) : [];
        refsLine.replaceChildren(
            h('label.iig-inline-check', {}, useRefs, h('span', {}, 'References')),
            matched.length
                ? h('div.iig-chips', {}, matched.map(m => h('span.iig-chip.static', { title: m.reason === 'always' ? 'Always sent' : 'Name found in prompt' },
                    h('img.iig-chip-thumb', { src: m.path, alt: '' }), m.name)))
                : h('span.iig-muted', {}, useRefs.checked ? 'None match this prompt' : 'Off'),
            h('button.iig-link', { type: 'button', onclick: () => show('refs') }, 'Manage'),
        );
    }, 150);

    // --- advanced
    const negative = h('input.iig-input', { type: 'text', value: draft.negative_prompt || '', placeholder: settings().negativePrompt || 'Things to avoid', oninput: () => set('negative_prompt', negative.value) });
    const seed = h('input.iig-input', { type: 'number', inputmode: 'numeric', value: draft.seed ?? '', placeholder: 'Random', oninput: () => set('seed', seed.value) });
    const more = h('details.iig-more', {}, h('summary', {}, 'More options'), h('div.iig-row-2', {}, field('Negative prompt', negative), field('Seed', seed)));

    // --- generate
    const goLabel = h('span', {}, (draft.count || 1) > 1 ? `Generate ${draft.count}` : 'Generate');
    const goBtn = h('button.iig-btn.primary.iig-go', { type: 'button', onclick: () => go() }, icon('wand-magic-sparkles'), goLabel);

    function go() {
        const text = prompt.value.trim();
        if (!text) {
            prompt.focus();
            prompt.classList.add('iig-shake');
            setTimeout(() => prompt.classList.remove('iig-shake'), 400);
            return;
        }
        const data = {
            prompt: text,
            style: style.value.trim() || settings().defaultStyle || undefined,
            aspect_ratio: draft.aspect_ratio || settings().aspectRatio,
            image_size: draft.image_size || settings().imageSize,
            negative_prompt: negative.value.trim() || undefined,
            seed: seed.value === '' ? undefined : Number(seed.value),
            no_refs: !useRefs.checked || undefined,
        };
        const jobs = runStudio({ kind: draft.kind || 'image', data, count: Number(draft.count) || 1 });
        toast.info(jobs.length > 1 ? `Queued ${jobs.length}` : 'Queued');
        renderResults();
    }

    // --- results
    const results = h('div.iig-grid');
    const resultsHead = h('div.iig-subhead', {}, h('span', {}, 'Results in this chat'), h('button.iig-link', { type: 'button', onclick: () => show('gallery') }, 'Gallery'));
    const usePrompt = (item) => {
        prompt.value = item.prompt || '';
        set('prompt', prompt.value);
        if (item.data?.style) { style.value = item.data.style; set('style', item.data.style); markStyle(); }
        if (item.data?.aspect_ratio) { ar.set(item.data.aspect_ratio); set('aspect_ratio', item.data.aspect_ratio); }
        updateRefs();
        prompt.focus();
    };
    function renderResults() {
        const running = queue.allJobs().filter(j => j.meta.source === 'studio' && ['queued', 'running'].includes(j.status)).reverse();
        const done = studioHistory().slice(0, 24);
        const tiles = [
            ...running.map(j => h('div.iig-tile.is-pending', { style: { aspectRatio: String(j.meta.aspectRatio || '1:1').replace(':', ' / ') }, title: j.prompt },
                h('div.iig-ph-shimmer'),
                h('div.iig-tile-status', {}, icon('spinner', 'fa-spin'), h('span', {}, j.status === 'queued' ? 'Queued' : j.statusText)),
                h('button.iig-tile-x', { type: 'button', 'aria-label': 'Cancel', onclick: () => queue.cancel(j.id) }, icon('xmark')),
            )),
            ...done.map((item, i) => tile(item, { onOpen: () => openViewer(done, i, it => studioItemActions(it, { usePrompt })) })),
        ];
        results.replaceChildren(...(tiles.length ? tiles : [empty('images', 'Nothing yet', 'Your studio images for this chat show up here.')]));
    }

    function syncKind() {
        const isVideo = (draft.kind || 'image') === 'video';
        sizeField.hidden = isVideo;
        updateRefs();
    }

    const el = h('section', {},
        h('div.iig-card', {},
            h('div.iig-row.between', {}, kind.el, h('div.iig-row', {}, sceneBtn, clearBtn)),
            prompt,
            refsLine,
        ),
        h('div.iig-card', {},
            field('Style', h('div.iig-stack', {}, style, styleChips)),
            field('Aspect ratio', ar.el),
            h('div.iig-row-2', {}, sizeField, field('How many', stepper)),
            more,
        ),
        h('div.iig-sticky-foot', {}, goBtn),
        resultsHead,
        results,
    );

    renderStyles();
    syncKind();
    renderResults();
    onStudioChange(renderResults);
    queue.onQueue((job) => { if (!job || job.meta.source === 'studio') renderResults(); });
    onSettingsChange((key) => {
        if (key === 'styles' || key === 'all') renderStyles();
        if (['refs', 'provider', 'sendRefs', 'all', 'profile'].includes(key)) updateRefs();
    });

    return {
        id: 'create',
        label: 'Create',
        icon: 'wand-magic-sparkles',
        el,
        onShow: () => { renderResults(); updateRefs(); },
        setPrompt: usePrompt,
    };
}
