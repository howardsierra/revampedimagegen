/*
 * Revamped Image Gen — "Use as reference": turn any image into a character's
 * reference photo for this chat, this character, or all chats.
 * Licensed under AGPL-3.0-or-later.
 */

import { layerAvailable, refLayer, settings } from '../settings.js';
import { getCharName, getUserName, toast } from '../st.js';
import { chipSelect, field, h, icon, setChildren } from './dom.js';
import { LAYER_LABEL, useImageAsRef } from './tab-refs.js';

export function openRefPicker(item) {
    const layers = ['chat', 'character', 'global'].filter(layerAvailable);
    let layer = layers.includes(settings().refsEditLayer) ? settings().refsEditLayer : layers[0];
    let target = 'char';

    const lastFocus = document.activeElement;
    const targets = h('div.iig-stack');
    const newName = h('input.iig-input', { type: 'text', placeholder: 'Name (and aliases, comma-separated)', hidden: true });

    function drawTargets() {
        const set = refLayer(layer);
        const opts = [
            { value: 'char', label: `Main character${getCharName() ? ` — ${set?.char?.name || getCharName()}` : ''}` },
            { value: 'user', label: `You${getUserName() ? ` — ${set?.user?.name || getUserName()}` : ''}` },
            ...(set?.npcs || []).map(n => ({ value: n.id, label: n.name || 'Unnamed character' })),
            { value: 'new', label: '+ New character' },
        ];
        if (!opts.some(o => o.value === target)) target = 'char';
        const sel = chipSelect(opts, target, (v) => { target = v; newName.hidden = v !== 'new'; if (v === 'new') newName.focus(); });
        setChildren(targets, sel.el, newName);
        newName.hidden = target !== 'new';
    }

    const layerSel = chipSelect(layers.map(l => ({ value: l, label: LAYER_LABEL[l] })), layer, (v) => { layer = v; drawTargets(); });
    drawTargets();

    const done = () => {
        modal.classList.remove('is-open');
        setTimeout(() => modal.remove(), 200);
        lastFocus?.focus?.();
    };
    const saveBtn = h('button.iig-btn.primary', {
        type: 'button', onclick: async () => {
            if (target === 'new' && !newName.value.trim()) { newName.focus(); return; }
            saveBtn.disabled = true;
            saveBtn.classList.add('is-busy');
            try {
                const slot = await useImageAsRef(item.src, { layer, target, name: target === 'new' ? newName.value.trim() : '' });
                toast.success(`Reference saved for ${slot.name || (target === 'user' ? getUserName() : getCharName()) || 'character'} (${LAYER_LABEL[layer].toLowerCase()})`);
                done();
            } catch (e) {
                toast.error(e.message);
                saveBtn.disabled = false;
                saveBtn.classList.remove('is-busy');
            }
        },
    }, icon('user-check'), ' Save reference');

    const modal = h('div.iig-modal', { onclick: (e) => { if (e.target === modal) done(); } },
        h('div.iig-modal-card', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Use as reference' },
            h('div.iig-grab', { 'aria-hidden': 'true' }, h('span')),
            h('header.iig-modal-head', {}, h('h3', {}, 'Use as reference'), h('button.iig-icon-btn', { type: 'button', 'aria-label': 'Close', onclick: done }, icon('xmark'))),
            h('div.iig-modal-body', {},
                h('div.iig-row', {}, h('img.iig-ref-preview', { src: item.src, alt: '' }),
                    h('p.iig-muted.small', {}, 'Future images that mention this character will use this picture to keep their look consistent.')),
                field('For', targets),
                field('Where', layerSel.el),
            ),
            h('footer.iig-modal-foot', {}, h('button.iig-btn', { type: 'button', onclick: done }, 'Cancel'), saveBtn),
        ),
    );
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } });
    document.getElementById('iig-root').append(modal);
    requestAnimationFrame(() => modal.classList.add('is-open'));
}
