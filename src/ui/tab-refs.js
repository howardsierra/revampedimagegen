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
    save, saveRefs, setMuted, setSlotPaths, settings, slotPaths,
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

function pickFiles() {
    return new Promise((resolve) => {
        const input = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
        input.addEventListener('change', () => { resolve([...(input.files || [])]); input.remove(); });
        document.body.append(input);
        input.click();
    });
}

/** Compress + upload `dataUrl` and add it to `slot`'s photos. */
export async function addSlotPhoto(slot, dataUrl, slug, layer) {
    const compressed = await compressImage(dataUrl, 1024, 0.88);
    const path = await uploadRef(compressed, slug);
    setSlotPaths(slot, [...slotPaths(slot), path]);
    saveRefs(layer);
    return path;
}

/** Delete a file we uploaded once no reference set uses it any more. */
async function deleteIfUnused(path) {
    clearRefCache(path);
    if (path && path.includes('/iig_refs/') && !knownRefPaths().has(path)) await deleteFile(path);
}

/** Take one photo off `slot` (and delete its file if nothing else uses it). */
export async function removeSlotPhoto(slot, path, layer) {
    setSlotPaths(slot, slotPaths(slot).filter(p => p !== path));
    saveRefs(layer);
    await deleteIfUnused(path);
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
    await addSlotPhoto(slot, await blobToDataUrl(await res.blob()), `${target}_${slot.name || 'ref'}`, layer);
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
                `${x.name}${x.photos > 1 ? ` ${x.photo}/${x.photos}` : ''}${x.reason === 'always' ? ' (always)' : ''}`, h('small.iig-layer-tag', {}, LAYER_LABEL[x.layer])))
            : [h('span.iig-muted', {}, tester.value ? 'No reference would be sent' : '')]));
    }

    function slotCard(layer, slot, { kind, title, placeholder, onDelete }) {
        const slug = () => `${kind}_${(slot.name.split(',')[0] || placeholder || kind).trim()}`;
        const photos = slotPaths(slot);
        const label = slot.name.split(',')[0].trim() || placeholder || title;

        // Edits go through the live layer object (it may be created on first edit).
        const live = () => {
            const set = refLayer(layer, { create: true });
            if (kind === 'char') return set.char;
            if (kind === 'user') return set.user;
            return set.npcs.find(n => n.id === slot.id) || slot;
        };

        const gallery = h('div.iig-ref-photos', { role: 'list', 'aria-label': `${label} photos` },
            photos.map((p, i) => h('div.iig-ref-photo', { role: 'listitem' },
                h('button.iig-ref-thumb', {
                    type: 'button', title: 'View',
                    onclick: () => openViewer(photos.map(src => ({ src, prompt: slot.name || placeholder })), i),
                }, h('img', { src: p, alt: `${label}, photo ${i + 1}` })),
                h('button.iig-ref-photo-x', {
                    type: 'button', 'aria-label': `Remove photo ${i + 1}`, title: 'Remove this photo',
                    onclick: async () => { await removeSlotPhoto(live(), p, layer); render(); },
                }, icon('xmark')),
                i === 0 && photos.length > 1 ? h('span.iig-ref-photo-main', { 'aria-hidden': 'true' }, 'Main') : null,
            )),
            h('button.iig-ref-thumb.empty', { type: 'button', title: photos.length ? 'Add more photos' : 'Add photos', 'aria-label': 'Add photos', onclick: () => upload() }, icon(photos.length ? 'plus' : 'user-plus')),
        );

        const name = h('input.iig-input', {
            type: 'text', value: slot.name, placeholder: placeholder ? `${placeholder} (auto)` : 'Name, aliases…',
            'aria-label': `${title} name`,
            oninput: debounce(() => { live().name = name.value; saveRefs(layer); renderTest(); }, 250),
        });

        async function upload(fromUrl) {
            try {
                const dataUrls = [];
                if (fromUrl) {
                    const res = await fetch(fromUrl);
                    if (!res.ok) throw new Error(`Could not load avatar (${res.status})`);
                    dataUrls.push(await blobToDataUrl(await res.blob()));
                } else {
                    const files = await pickFiles();
                    if (!files.length) return;
                    for (const f of files) dataUrls.push(await blobToDataUrl(f));
                }
                card.classList.add('is-busy');
                for (const d of dataUrls) await addSlotPhoto(live(), d, slug(), layer);
                toast.success(`${dataUrls.length > 1 ? `${dataUrls.length} photos` : 'Photo'} saved to ${LAYER_LABEL[layer].toLowerCase()}`);
                render();
            } catch (e) {
                log('error', e);
                toast.error(`Upload failed: ${e.message}`);
                card.classList.remove('is-busy');
                render();
            }
        }

        const avatarBtn = kind === 'char' && avatarUrl()
            ? h('button.iig-btn.small.ghost', { type: 'button', title: 'Use the character card image', onclick: () => upload(avatarUrl()) }, icon('id-badge'), h('span', {}, 'Card avatar'))
            : null;

        const card = h('div.iig-ref-card', {},
            h('div.iig-ref-main', {},
                h('div.iig-ref-title', {}, title, photos.length ? h('small.iig-muted', {}, ` · ${photos.length} photo${photos.length > 1 ? 's' : ''}`) : null),
                gallery,
                name,
                toggle('Always send', slot.always, (v) => { live().always = v; saveRefs(layer); renderTest(); }, kind === 'npc' ? null : 'Even when the name is not in the prompt'),
                h('div.iig-row.wrap', {},
                    h('button.iig-btn.small', { type: 'button', onclick: () => upload() }, icon('upload'), h('span', {}, photos.length ? 'Add photos' : 'Upload')),
                    avatarBtn,
                    photos.length > 1 ? h('button.iig-btn.small.ghost', {
                        type: 'button', onclick: async () => {
                            if (!await confirmDialog(`Remove all ${photos.length} photos of ${label}?`, { okLabel: 'Remove', danger: true })) return;
                            const s = live();
                            const old = slotPaths(s);
                            setSlotPaths(s, []);
                            saveRefs(layer);
                            for (const p of old) await deleteIfUnused(p);
                            render();
                        },
                    }, icon('images'), h('span', {}, 'Remove all')) : null,
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
            return [set.char, set.user, ...set.npcs].reduce((n, x) => n + slotPaths(x).length, 0);
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
                for (const p of slotPaths(removed)) await deleteIfUnused(p);
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
                field('Test matching', tester, 'A character\'s photos are sent when their name (or any comma-separated alias) is in the prompt as a whole word. Several photos (angles, outfits, expressions) keep the look steadier; when the limit is tight, every character\'s first photo goes before anyone\'s second. Tip: open any generated image and tap "Use as ref" to add it.'),
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
