/*
 * Revamped Image Gen — Gallery tab: everything generated in this chat
 * (from messages and the studio), searchable, with full-screen viewing.
 * Licensed under AGPL-3.0-or-later.
 */

import * as chat from '../chat.js';
import * as queue from '../queue.js';
import { onStudioChange, studioHistory } from '../studio.js';
import { chatItemActions, studioItemActions } from './actions.js';
import { chipSelect, debounce, h, icon } from './dom.js';
import { openViewer } from './viewer.js';
import { empty, tile } from './widgets.js';

export function createGalleryTab({ setPrompt }) {
    let filter = 'all';
    let query = '';
    let visible = false;

    const grid = h('div.iig-grid.iig-grid-gallery');
    const count = h('span.iig-muted');
    const seg = chipSelect([
        { value: 'all', label: 'All' },
        { value: 'chat', label: 'In chat' },
        { value: 'studio', label: 'Studio' },
    ], filter, v => { filter = v; render(); }, { className: 'iig-seg' });
    const search = h('input.iig-input.iig-search', {
        type: 'search', placeholder: 'Search prompts…', 'aria-label': 'Search prompts',
        oninput: debounce(() => { query = search.value.trim().toLowerCase(); render(); }, 150),
    });

    function items() {
        const fromChat = filter === 'studio' ? [] : chat.chatMedia();
        const fromStudio = filter === 'chat' ? [] : studioHistory();
        let all = [...fromStudio.map(i => ({ ...i, source: 'studio' })), ...fromChat];
        if (filter === 'all') all.sort((a, b) => (b.t || 0) - (a.t || 0) || (b.mesId ?? -1) - (a.mesId ?? -1));
        if (query) all = all.filter(i => String(i.prompt || '').toLowerCase().includes(query));
        return all;
    }

    function render() {
        if (!visible) return;
        const list = items();
        count.textContent = list.length ? `${list.length} item${list.length > 1 ? 's' : ''}` : '';
        if (!list.length) {
            grid.replaceChildren(empty('images', query ? 'No matches' : 'No images yet',
                query ? 'Try a different word.' : 'Images from this chat\'s messages and the studio collect here.'));
            return;
        }
        const actions = (item) => (item.source === 'studio'
            ? studioItemActions(item, { usePrompt: (it) => setPrompt(it) })
            : chatItemActions(item));
        grid.replaceChildren(...list.map((item, i) => tile(item, {
            onOpen: () => openViewer(list, i, actions),
            badge: item.source === 'studio' ? icon('palette') : null,
        })));
    }

    const el = h('section', {},
        h('div.iig-pad.iig-stack', {}, h('div.iig-row.between', {}, seg.el, count), search),
        grid,
    );

    onStudioChange(render);
    queue.onQueue((job) => { if (job?.status === 'done') render(); });

    return {
        id: 'gallery',
        label: 'Gallery',
        icon: 'images',
        el,
        onShow: () => { visible = true; render(); },
        onHide: () => { visible = false; },
        refresh: render,
    };
}
