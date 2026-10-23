/*
 * Revamped Image Gen — References tab: photos that keep characters looking
 * consistent. Unlimited NPC slots, aliases, "always send", a live match tester
 * and one-tap "use character card avatar". Licensed under AGPL-3.0-or-later.
 */

import { compressImage, blobToDataUrl } from '../net.js';
import { clearRefCache, matchRefs } from '../refs.js';
import { chatHasOwnRefs, editableRefs, activeRefs, isPerChat, knownRefPaths, onSettingsChange, resetChatRefs, save, saveRefs, settings } from '../settings.js';
import { ctx, getCharName, getUserName, log, toast, uid } from '../st.js';
import { deleteFile, uploadRef } from '../storage.js';
import { chipSelect, debounce, field, h, icon, toggle } from './dom.js';
import { confirmDialog } from './editor.js';
import { openViewer } from './viewer.js';

function pickFile() {
    return new Promise((resolve) => {
        const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
        input.addEventListener('change', () => { resolve(input.files?.[0] || null); input.remove(); });
        document.body.append(input);
        input.click();
    });
}

async function replacePhoto(slot, dataUrl, slug) {
    const compressed = await compressImage(dataUrl, 1024, 0.88);
    const path = await uploadRef(compressed, slug);
    const old = slot.path;
    slot.path = path;
    saveRefs();
    clearRefCache(old);
    // Only delete the old file if nothing else still points at it.
    if (old && old.includes('/iig_refs/') && !knownRefPaths().has(old)) await deleteFile(old);
    return path;
}

export function createRefsTab() {
    const el = h('section');
    const tester = h('input.iig-input', { type: 'text', placeholder: 'Type a prompt to see which photos get sent…', oninput: debounce(() => renderTest(), 120) });
    const testOut = h('div.iig-chips');
    let visible = false;

    function renderTest() {
        const m = matchRefs(tester.value);
        testOut.replaceChildren(...(m.length
            ? m.map(x => h('span.iig-chip.static', {}, h('img.iig-chip-thumb', { src: x.path, alt: '' }), `${x.name}${x.reason === 'always' ? ' (always)' : ''}`))
            : [h('span.iig-muted', {}, tester.value ? 'No reference would be sent' : '')]));
    }

    function slotCard(slot, { kind, title, placeholder, onDelete }) {
        const slug = () => `${kind}_${(slot.name.split(',')[0] || placeholder || kind).trim()}`;
        const thumb = slot.path
            ? h('button.iig-ref-thumb', { type: 'button', title: 'View', onclick: () => openViewer([{ src: slot.path, prompt: slot.name || placeholder }], 0) }, h('img', { src: slot.path, alt: slot.name || title }))
            : h('button.iig-ref-thumb.empty', { type: 'button', title: 'Add photo', onclick: () => upload() }, icon('user-plus'));

        const name = h('input.iig-input', {
            type: 'text', value: slot.name, placeholder: placeholder ? `${placeholder} (auto)` : 'Name, aliases…',
            'aria-label': `${title} name`,
            oninput: debounce(() => { editableSlot().name = name.value; saveRefs(); renderTest(); }, 250),
        });

        // In per-chat mode the first edit forks a copy; always edit through the live set.
        const editableSlot = () => {
            const set = editableRefs();
            if (kind === 'char') return set.char;
            if (kind === 'user') return set.user;
            return set.npcs.find(n => n.id === slot.id) || slot;
        };

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
                await replacePhoto(editableSlot(), dataUrl, slug());
                toast.success('Reference saved');
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
                toggle('Always send', slot.always, (v) => { editableSlot().always = v; saveRefs(); renderTest(); }, kind === 'npc' ? null : 'Even when the name is not in the prompt'),
                h('div.iig-row.wrap', {},
                    h('button.iig-btn.small', { type: 'button', onclick: () => upload() }, icon(slot.path ? 'arrows-rotate' : 'upload'), h('span', {}, slot.path ? 'Replace' : 'Upload')),
                    avatarBtn,
                    slot.path ? h('button.iig-btn.small.ghost', {
                        type: 'button', onclick: async () => {
                            const s = editableSlot();
                            const old = s.path;
                            s.path = '';
                            saveRefs();
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

    function render() {
        if (!visible) return;
        const s = settings();
        const refs = isPerChat() ? activeRefs() : s.refs;
        const scope = chipSelect([{ value: 'global', label: 'All chats' }, { value: 'chat', label: 'Per chat' }], s.refScope, (v) => {
            s.refScope = v;
            save('refs');
            render();
        });
        const scopeNote = isPerChat()
            ? h('div.iig-row.between', {},
                h('small.iig-muted', {}, chatHasOwnRefs() ? 'This chat has its own set.' : 'Using the global set until you edit something here.'),
                chatHasOwnRefs() ? h('button.iig-btn.small.ghost', {
                    type: 'button', onclick: async () => {
                        if (await confirmDialog('Discard this chat\'s references and go back to the global set?', { okLabel: 'Reset' })) { resetChatRefs(); render(); }
                    },
                }, icon('rotate-left'), h('span', {}, 'Use global')) : null)
            : h('small.iig-muted', {}, 'One set shared by every chat.');

        const maxInput = h('input.iig-input.narrow', {
            type: 'number', min: 1, max: 8, value: s.maxRefs,
            onchange: () => { s.maxRefs = Math.min(8, Math.max(1, Number(maxInput.value) || 4)); save('maxRefs'); renderTest(); },
        });

        const npcCards = (refs.npcs || []).map(n => slotCard(n, {
            kind: 'npc', title: 'Character', placeholder: '',
            onDelete: async () => {
                if (!await confirmDialog(`Delete ${n.name || 'this character'}?`, { okLabel: 'Delete', danger: true })) return;
                const set = editableRefs();
                const idx = set.npcs.findIndex(x => x.id === n.id);
                const [removed] = idx >= 0 ? set.npcs.splice(idx, 1) : [];
                saveRefs();
                if (removed?.path?.includes('/iig_refs/') && !knownRefPaths().has(removed.path)) await deleteFile(removed.path);
                render();
            },
        }));

        el.replaceChildren(
            h('div.iig-card', {},
                field('Where references live', scope.el),
                scopeNote,
                h('p.iig-muted.small', {}, 'A photo is sent when its name (or any comma-separated alias) appears in the image prompt as a whole word. Priority: character → you → others.'),
                h('div.iig-row.between', {}, h('span', {}, 'Max photos per image'), maxInput),
            ),
            slotCard(refs.char, { kind: 'char', title: 'Main character', placeholder: getCharName() }),
            slotCard(refs.user, { kind: 'user', title: 'You (persona)', placeholder: getUserName() }),
            ...npcCards,
            h('button.iig-btn.block', {
                type: 'button', onclick: () => {
                    editableRefs().npcs.push({ id: uid('npc'), name: '', path: '', always: false });
                    saveRefs();
                    render();
                    el.querySelector('.iig-ref-card:last-of-type input')?.focus();
                },
            }, icon('plus'), h('span', {}, 'Add character')),
            h('div.iig-card', {}, field('Test matching', tester), testOut),
        );
        renderTest();
    }

    onSettingsChange((key) => { if (key === 'all' || key === 'chat') render(); });

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
