/*
 * Revamped Image Gen — model picker.
 *
 * One place to choose a model on any device: a bottom sheet on phones, a
 * dialog elsewhere. It lists the image models the user's key can actually
 * use (fetched live), recommends the best ones, shows what each can do, and
 * still accepts any custom id. Licensed under AGPL-3.0-or-later.
 */

import { RECIPES, bestModel, modelCaps } from '../models.js';
import { listModels, resolveId } from '../model-list.js';
import { getProvider } from '../providers.js';
import { onSettingsChange, save, settings } from '../settings.js';
import { toast } from '../st.js';
import { debounce, h, icon, setChildren } from './dom.js';

function capsChips(id) {
    const c = modelCaps(id);
    const out = [];
    if (c.sizes?.length) out.push(c.sizes.filter(x => x !== '512').join(' · '));
    if (c.hardRefs) out.push(`${c.hardRefs} refs`);
    else if (c.family !== 'other') out.push('no refs');
    return out;
}

/** Pick a model. Resolves with the chosen id, or null if dismissed. */
export function openModelPicker() {
    return new Promise((resolve) => {
        const s = settings();
        const provider = getProvider(s.provider);
        const recipe = RECIPES.find(r => r.provider === s.provider && r.models.length);
        let showAll = false;
        let query = '';
        let state = { loading: !!provider.listModels, ids: [], images: [], error: null, fetched: false };

        const list = h('div.iig-mp-list', { role: 'listbox', 'aria-label': 'Models' });
        const status = h('div.iig-mp-status');
        const search = h('input.iig-input.iig-search', {
            type: 'search', placeholder: 'Search models…', 'aria-label': 'Search models', autocomplete: 'off',
            oninput: debounce(() => { query = search.value.trim().toLowerCase(); draw(); }, 120),
        });
        const custom = h('input.iig-input.mono', { type: 'text', placeholder: 'Or type any model id', value: '', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Custom model id' });
        const allToggle = h('label.iig-inline-check', {}, h('input', { type: 'checkbox', onchange: (e) => { showAll = e.target.checked; draw(); } }), h('span', {}, 'Show non-image models'));

        const choose = (id) => {
            if (!id) return;
            const st = settings();
            st.model = id;
            save('model');
            const c = modelCaps(id);
            if (c.unsupported) toast.warn(c.unsupported);
            else toast.success(`Model: ${c.label || id}`);
            close(id);
        };

        function row(id, { badge, recommended } = {}) {
            const c = modelCaps(id);
            const current = id === settings().model;
            const missing = state.fetched && state.ids.length && !state.ids.includes(id);
            return h(`button.iig-mp-row${current ? '.is-current' : ''}${missing ? '.is-missing' : ''}`, {
                type: 'button', role: 'option', 'aria-selected': current ? 'true' : 'false',
                title: c.note || id,
                onclick: () => {
                    if (missing && !confirm(`"${id}" is not in your account's model list. Use it anyway?`)) return;
                    choose(id);
                },
            },
            h('span.iig-mp-main', {},
                h('span.iig-mp-name', {}, c.label || id, recommended ? h('span.iig-mp-tag', {}, 'Recommended') : null, badge ? h('span.iig-mp-tag.best', {}, badge) : null),
                h('span.iig-mp-id', {}, id),
                c.note ? h('span.iig-mp-note', {}, c.unsupported || c.note) : null,
            ),
            h('span.iig-mp-side', {},
                ...capsChips(id).map(t => h('span.iig-mp-chip', {}, t)),
                missing ? h('span.iig-mp-chip.warn', {}, 'not on your key') : null,
                current ? h('span.iig-mp-check', { 'aria-hidden': 'true' }, icon('check')) : null,
            ));
        }

        function draw() {
            const match = (id) => !query || id.toLowerCase().includes(query) || (modelCaps(id).label || '').toLowerCase().includes(query);
            const best = bestModel(state.images);
            // Recommended ids, mapped onto the real ids the key has (e.g. "-preview" variants).
            const recs = (recipe?.models || []).map(id => (state.fetched ? resolveId(id, state.ids) || id : id));
            const recSet = new Set(recs);
            const available = (showAll ? state.ids : state.images).filter(id => !recSet.has(id));
            const children = [];
            const recRows = [...new Set(recs)].filter(match);
            if (recRows.length) {
                children.push(h('div.iig-mp-head', {}, 'Recommended'));
                children.push(...recRows.map(id => row(id, { recommended: false, badge: id === best ? 'Best on your key' : null })));
            }
            const avRows = available.filter(match);
            if (state.fetched && avRows.length) {
                children.push(h('div.iig-mp-head', {}, recRows.length ? 'Also on your key' : 'On your key'));
                children.push(...avRows.map(id => row(id, { badge: id === best && !recSet.has(id) ? 'Best on your key' : null })));
            }
            if (!children.length) {
                children.push(h('div.iig-empty', {}, h('div.iig-empty-icon', {}, icon('magnifying-glass')),
                    h('div.iig-empty-title', {}, state.loading ? 'Loading models…' : 'No matching models'),
                    h('p', {}, state.loading ? '' : 'Type the exact id below, or check your connection.')));
            }
            setChildren(list, ...children);

            if (state.loading) setChildren(status, icon('spinner', 'fa-spin'), h('span', {}, ' Checking which models your key can use…'));
            else if (state.error) {
                const st = state.error.status;
                const why = st === 401 || st === 403 ? 'your API key was rejected' : st === 404 ? 'the endpoint URL looks wrong' : state.error.network ? 'the provider could not be reached' : state.error.message;
                setChildren(status, h('span.iig-mp-err', {}, icon('triangle-exclamation'), ` Couldn't list models — ${why}. You can still type an id.`));
            } else if (state.fetched) setChildren(status, ...[h('span', {}, `${state.images.length} image model${state.images.length === 1 ? '' : 's'} on your key`), best ? h('button.iig-link', { type: 'button', onclick: () => choose(best) }, `Use the best (${modelCaps(best).label || best})`) : null].filter(Boolean));
            else setChildren(status, h('span', {}, provider.listModels ? 'Add your API key to see the models it can use.' : `${provider.label} has no model list — type an id.`));
        }

        async function load(force = false) {
            if (!provider.listModels || (provider.keyRequired && !settings().apiKey)) {
                state = { ...state, loading: false };
                draw();
                return;
            }
            state = { ...state, loading: true };
            draw();
            const res = await listModels({ force });
            state = { loading: false, ids: res.ids, images: res.images, error: res.error, fetched: !res.error };
            draw();
        }

        const lastFocus = document.activeElement;
        const close = (val = null) => {
            modal.classList.remove('is-open');
            setTimeout(() => modal.remove(), 200);
            lastFocus?.focus?.();
            resolve(val);
        };

        const card = h('div.iig-modal-card.iig-mp', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose a model' },
            h('div.iig-grab', { 'aria-hidden': 'true' }, h('span')),
            h('header.iig-modal-head', {},
                h('div', {}, h('h3', {}, 'Choose a model'), h('small.iig-muted', {}, provider.label)),
                h('div.iig-row', {},
                    provider.listModels ? h('button.iig-icon-btn', { type: 'button', title: 'Refresh', 'aria-label': 'Refresh model list', onclick: () => load(true) }, icon('arrows-rotate')) : null,
                    h('button.iig-icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('xmark')),
                ),
            ),
            h('div.iig-mp-top', {}, search, status),
            h('div.iig-modal-body.iig-mp-body', {}, list),
            h('footer.iig-modal-foot.iig-mp-foot', {},
                h('div.iig-input-group', {}, custom, h('button.iig-btn', { type: 'button', onclick: () => choose(custom.value.trim()) }, 'Use')),
                provider.listModels ? allToggle : null,
            ),
        );
        const modal = h('div.iig-modal', { onclick: (e) => { if (e.target === modal) close(); } }, card);
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); close(); }
            if (e.key === 'Enter' && e.target === custom) choose(custom.value.trim());
        });
        document.getElementById('iig-root').append(modal);
        requestAnimationFrame(() => {
            modal.classList.add('is-open');
            if (!matchMedia('(pointer: coarse)').matches) search.focus();
        });
        draw();
        load();
    });
}

/**
 * A button showing the current model ("Nano Banana Pro · gemini-3-pro-image")
 * that opens the picker. `compact` renders a small chip for the Create tab.
 */
export function modelButton({ compact = false } = {}) {
    const el = h(`button.iig-model-btn${compact ? '.compact' : ''}`, { type: 'button', onclick: () => openModelPicker() });
    const refresh = () => {
        const id = settings().model;
        const c = modelCaps(id);
        const name = id ? (c.label || id) : 'Choose a model';
        el.classList.toggle('is-empty', !id);
        el.title = id ? `${name} — ${id}. Tap to change.` : 'Choose a model';
        setChildren(el, 
            icon(c.family === 'gpt-image' ? 'image' : c.family === 'nano-banana' ? 'wand-magic-sparkles' : 'cube'),
            compact
                ? h('span.iig-model-btn-name', {}, name)
                : h('span.iig-model-btn-text', {}, h('span.iig-model-btn-name', {}, name), id && c.label ? h('span.iig-model-btn-id', {}, id) : null),
            icon('chevron-down', 'iig-model-btn-caret'),
        );
    };
    refresh();
    onSettingsChange((key) => { if (['model', 'provider', 'profile', 'all'].includes(key)) refresh(); });
    return { el, refresh };
}
