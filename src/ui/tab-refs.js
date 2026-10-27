/*
 * Revamped Image Gen — References tab.
 *
 * Photos live in three layers: this chat, this character (all of its chats),
 * and all chats. The tab edits one layer at a time, shows what is inherited
 * from the others, and lets a chat mute inherited photos it does not want.
 * Licensed under AGPL-3.0-or-later.
 */

import { compressImage, blobToDataUrl } from '../net.js';
import { clearRefCache, matchRefs, maxRefsFor } from '../refs.js';
import {
    inheritedRefs, isMuted, knownRefPaths, layerAvailable, onSettingsChange, refLayer, resetChatRefs,
    save, saveRefs, setMuted, settings,
} from '../settings.js';
import { ctx, getCharName, getUserName, log, toast, uid } from '../st.js';
import { deleteFile, uploadRef } from '../storage.js';
import { chipSelect, debounce, field, h, icon, setChildren, toggle } from './dom.js';
import { confirmDialog } from './editor.js';
import { openViewer } from './viewer.js';

export const LAYER_LABEL = { chat: 'This chat', character: 'This character', global: 'All chats' };
const LAYER_HINT = {
    chat: 'Only used in this chat. Overrides the other layers.',
    character: 'Used in every chat with this character card.',
    global: 'Used everywhere unless a chat or character overrides it.',
};

function pickFile() {
    return new Promise((resolve) => {
        const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
        input.addEventListener('change', () => { resolve(input.files?.[0] || null); input.remove(); });
        document.body.append(input);
        input.click();
    });
}

/** Compress + upload `dataUrl` and point `slot` at it; deletes the old file if nothing else uses it. */
export async function setSlotPhoto(slot, dataUrl, slug, layer) {
    const compressed = await compressImage(dataUrl, 1024, 0.88);
    const path = await uploadRef(compressed, slug);
    const old = slot.path;
    slot.path = path;
    saveRefs(layer);
    clearRefCache(old);
    if (old && old.includes('/iig_refs/') && !knownRefPaths().has(old)) await deleteFile(old);
    return path;
}

/**
 * Make an existing image (e.g. a generated one) a reference.
 * target: 'char' | 'user' | npc id | 'new'
 */
export async function useImageAsRef(src, { layer, target, name }) {
    const set = refLayer(layer, { create: true });
    if (!set) throw new Error(`${LAYER_LABEL[layer]} is not available right now`);
    let slot;
    if (target === 'char') slot = set.char;
    else if (target === 'user') slot = set.user;
    else if (target === 'new') {
        slot = { id: uid('npc'), name: name || '', path: '', always: false };
        set.npcs.push(slot);
    } else slot = set.npcs.find(n => n.id === target);
    if (!slot) throw new Error('Reference slot not found');
    if (name && !slot.name) slot.name = name;
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Could not load image (${res.status})`);
    await setSlotPhoto(slot, await blobToDataUrl(await res.blob()), `${target}_${slot.name || 'ref'}`, layer);
    return slot;
}

export function createRefsTab() {
    const el = h('section');
    const tester = h('input.iig-input', { type: 'text', placeholder: 'Type a prompt to see which photos get sent…', oninput: debounce(() => renderTest(), 120) });
    const testOut = h('div.iig-chips');
    let visible = false;

    function renderTest() {
        const m = matchRefs(tester.value);
        setChildren(testOut, ...(m.length
            ? m.map(x => h('span.iig-chip.static', { title: LAYER_LABEL[x.layer] }, h('img.iig-chip-thumb', { src: x.path, alt: '' }),
                `${x.name}${x.reason === 'always' ? ' (always)' : ''}`, h('small.iig-layer-tag', {}, LAYER_LABEL[x.layer])))
            : [h('span.iig-muted', {}, tester.value ? 'No reference would be sent' : '')]));
    }

    function slotCard(layer, slot, { kind, title, placeholder, onDelete }) {
        const slug = () => `${kind}_${(slot.name.split(',')[0] || placeholder || kind).trim()}`;
        const thumb = slot.path
            ? h('button.iig-ref-thumb', { type: 'button', title: 'View', onclick: () => openViewer([{ src: slot.path, prompt: slot.name || placeholder }], 0) }, h('img', { src: slot.path, alt: slot.name || title }))
            : h('button.iig-ref-thumb.empty', { type: 'button', title: 'Add photo', onclick: () => upload() }, icon('user-plus'));

        // Edits go through the live layer object (it may be created on first edit).
        const live = () => {
            const set = refLayer(layer, { create: true });
            if (kind === 'char') return set.char;
            if (kind === 'user') return set.user;
            return set.npcs.find(n => n.id === slot.id) || slot;
        };

        const name = h('input.iig-input', {
            type: 'text', value: slot.name, placeholder: placeholder ? `${placeholder} (auto)` : 'Name, aliases…',
            'aria-label': `${title} name`,
            oninput: debounce(() => { live().name = name.value; saveRefs(layer); renderTest(); }, 250),
        });

        async function upload(fromUrl) {
            try {
                let dataUrl;
                if (fromUrl) {
                    const res = await fetch(fromUrl);
                    if (!res.ok) throw new Error(`Could not load avatar (${res.status})`);
                    dataUrl = await blobToDataUrl(await res.blob());
                } else {
                    const file = await pickFile();
                    if (!file) return;
                    dataUrl = await blobToDataUrl(file);
                }
                card.classList.add('is-busy');
                await setSlotPhoto(live(), dataUrl, slug(), layer);
                toast.success(`Saved to ${LAYER_LABEL[layer].toLowerCase()}`);
                render();
            } catch (e) {
                log('error', e);
                toast.error(`Upload failed: ${e.message}`);
                card.classList.remove('is-busy');
            }
        }

        const avatarBtn = kind === 'char' && avatarUrl()
            ? h('button.iig-btn.small.ghost', { type: 'button', title: 'Use the character card image', onclick: () => upload(avatarUrl()) }, icon('id-badge'), h('span', {}, 'Card avatar'))
            : null;

        const card = h('div.iig-ref-card', {},
            thumb,
            h('div.iig-ref-main', {},
                h('div.iig-ref-title', {}, title),
                name,
                toggle('Always send', slot.always, (v) => { live().always = v; saveRefs(layer); renderTest(); }, kind === 'npc' ? null : 'Even when the name is not in the prompt'),
                h('div.iig-row.wrap', {},
                    h('button.iig-btn.small', { type: 'button', onclick: () => upload() }, icon(slot.path ? 'arrows-rotate' : 'upload'), h('span', {}, slot.path ? 'Replace' : 'Upload')),
                    avatarBtn,
                    slot.path ? h('button.iig-btn.small.ghost', {
                        type: 'button', onclick: async () => {
                            const s = live();
                            const old = s.path;
                            s.path = '';
                            saveRefs(layer);
                            clearRefCache(old);
                            if (old.includes('/iig_refs/') && !knownRefPaths().has(old)) await deleteFile(old);
                            render();
                        },
                    }, icon('image'), h('span', {}, 'Remove photo')) : null,
                    onDelete ? h('button.iig-btn.small.ghost.danger', { type: 'button', onclick: onDelete }, icon('trash'), h('span', {}, 'Delete')) : null,
                ),
            ),
        );
        return card;
    }

    function avatarUrl() {
        const c = ctx();
        const a = c.characters?.[c.characterId]?.avatar;
        return a && a !== 'none' ? `/characters/${encodeURIComponent(a)}` : '';
    }

    function inheritedSection(layer) {
        const list = inheritedRefs(layer);
        if (!list.length) return null;
        const kindLabel = { char: 'Character', user: 'You', npc: 'Character' };
        return h('div.iig-card', {},
            h('div.iig-subhead', {}, h('span', {}, 'Inherited'), h('small.iig-muted', {}, layer === 'chat' ? 'Mute any you don\'t want in this chat' : '')),
            ...list.map(r => {
                const muted = isMuted(r.path);
                return h(`div.iig-inherit-row${muted ? '.is-muted' : ''}`, {},
                    h('img.iig-chip-thumb.big', { src: r.path, alt: '' }),
                    h('div.iig-inherit-main', {},
                        h('div', {}, r.name || (r.kind === 'char' ? getCharName() : r.kind === 'user' ? getUserName() : '') || kindLabel[r.kind]),
                        h('small.iig-muted', {}, `${kindLabel[r.kind]} · from ${LAYER_LABEL[r.layer].toLowerCase()}`),
                    ),
                    layer === 'chat'
                        ? h('button.iig-btn.small.ghost', {
                            type: 'button', title: muted ? 'Use in this chat again' : 'Don\'t send in this chat',
                            onclick: () => { setMuted(r.path, !muted); render(); },
                        }, icon(muted ? 'eye-slash' : 'eye'), h('span', {}, muted ? 'Muted' : 'On'))
                        : null,
                );
            }),
        );
    }

    function render() {
        if (!visible) return;
        const s = settings();
        const layers = ['chat', 'character', 'global'].filter(layerAvailable);
        if (!layers.includes(s.refsEditLayer)) s.refsEditLayer = layers[0] || 'global';
        const layer = s.refsEditLayer;
        const count = (l) => {
            const set = refLayer(l);
            if (!set) return 0;
            return [set.char, set.user, ...set.npcs].filter(x => x?.path).length;
        };
        const scope = chipSelect(layers.map(l => ({ value: l, label: `${LAYER_LABEL[l]}${count(l) ? ` · ${count(l)}` : ''}` })), layer, (v) => {
            s.refsEditLayer = v;
            save('refsEditLayer');
            render();
        }, { className: 'iig-chips-scroll' });

        // Show the layer even if it does not exist yet; it is created on the first edit.
        const set = refLayer(layer) || { char: { name: '', path: '', always: false }, user: { name: '', path: '', always: false }, npcs: [] };
        const maxInput = h('input.iig-input.narrow', {
            type: 'number', min: 0, max: 16, value: s.maxRefs, placeholder: 'Auto',
            onchange: () => { s.maxRefs = Math.min(16, Math.max(0, Number(maxInput.value) || 0)); save('maxRefs'); render(); },
        });

        const npcCards = (set.npcs || []).map(n => slotCard(layer, n, {
            kind: 'npc', title: 'Character', placeholder: '',
            onDelete: async () => {
                if (!await confirmDialog(`Delete ${n.name || 'this character'}?`, { okLabel: 'Delete', danger: true })) return;
                const live = refLayer(layer, { create: true });
                const idx = live.npcs.findIndex(x => x.id === n.id);
                const [removed] = idx >= 0 ? live.npcs.splice(idx, 1) : [];
                saveRefs(layer);
                if (removed?.path?.includes('/iig_refs/') && !knownRefPaths().has(removed.path)) await deleteFile(removed.path);
                render();
            },
        }));

        setChildren(el, 
            h('div.iig-card', {},
                field('Editing', scope.el, LAYER_HINT[layer]),
                layer === 'chat' && refLayer('chat') ? h('div.iig-row', {}, h('button.iig-btn.small.ghost', {
                    type: 'button', onclick: async () => {
                        if (await confirmDialog('Remove this chat\'s own references and mutes? Inherited ones keep working.', { okLabel: 'Clear' })) { resetChatRefs(); render(); }
                    },
                }, icon('rotate-left'), h('span', {}, 'Clear this chat\'s layer'))) : null,
                h('div.iig-row.between', {},
                    h('span', {}, 'Max photos per image'),
                    h('div.iig-row', {}, maxInput, h('small.iig-muted', {}, s.maxRefs ? '' : `auto: ${maxRefsFor()}`)),
                ),
            ),
            slotCard(layer, set.char, { kind: 'char', title: 'Main character', placeholder: getCharName() }),
            slotCard(layer, set.user, { kind: 'user', title: 'You (persona)', placeholder: getUserName() }),
            ...npcCards,
            h('button.iig-btn.block', {
                type: 'button', onclick: () => {
                    refLayer(layer, { create: true }).npcs.push({ id: uid('npc'), name: '', path: '', always: false });
                    saveRefs(layer);
                    render();
                    el.querySelector('.iig-ref-card:last-of-type input')?.focus();
                },
            }, icon('plus'), h('span', {}, 'Add character')),
            inheritedSection(layer),
            h('div.iig-card', {},
                field('Test matching', tester, 'A photo is sent when its name (or any comma-separated alias) is in the prompt as a whole word. Tip: open any generated image and tap "Use as ref" to lock a look in.'),
                testOut,
            ),
        );
        renderTest();
    }

    onSettingsChange((key) => { if (key === 'all') render(); });

    return {
        id: 'refs',
        label: 'Refs',
        icon: 'user-group',
        el,
        onShow: () => { visible = true; render(); },
        onHide: () => { visible = false; },
        refresh: render,
    };
}
