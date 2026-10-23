/*
 * Revamped Image Gen — quick actions on chat images: a hover toolbar for mouse
 * users and long-press for touch (needed for images inside interactive HTML,
 * where a tap belongs to the artifact). Licensed under AGPL-3.0-or-later.
 */

import * as chat from '../chat.js';
import { settings } from '../settings.js';
import { h, icon, downloadUrl, onLongPress } from './dom.js';
import { viewChatElement } from './actions.js';

const SELECTOR = '#chat .mes_text img.iig-img, #chat .mes_text img.iig-img-error';

export function installHover() {
    const bar = h('div.iig-hoverbar', { hidden: true, role: 'toolbar', 'aria-label': 'Image actions' });
    document.getElementById('iig-root').append(bar);
    let target = null;
    let hideTimer = null;

    const btn = (name, title, fn) => h('button.iig-icon-btn', {
        type: 'button', title, 'aria-label': title,
        onclick: (e) => { e.stopPropagation(); if (target) fn(target); hide(); },
    }, icon(name));

    function showFor(img) {
        if (!settings().hoverToolbar || !settings().enabled) return;
        clearTimeout(hideTimer);
        target = img;
        const isError = img.classList.contains('iig-img-error');
        bar.replaceChildren(
            btn('rotate-right', isError ? 'Retry' : 'Regenerate', el => chat.regenerateElement(el)),
            btn('expand', 'Open', el => viewChatElement(el)),
            isError ? null : btn('download', 'Save', el => downloadUrl(el.getAttribute('src'))),
        );
        const r = img.getBoundingClientRect();
        if (r.width < 80 || r.height < 60) return;
        bar.hidden = false;
        bar.style.top = `${Math.max(4, r.top + 8)}px`;
        bar.style.left = `${Math.min(innerWidth - bar.offsetWidth - 4, r.right - bar.offsetWidth - 8)}px`;
    }

    function hide() {
        bar.hidden = true;
        target = null;
    }

    document.addEventListener('pointerover', (e) => {
        if (e.pointerType !== 'mouse') return;
        const img = e.target.closest?.(SELECTOR);
        if (img) showFor(img);
    });
    document.addEventListener('pointerout', (e) => {
        if (e.pointerType !== 'mouse' || !target) return;
        const to = e.relatedTarget;
        if (to && (bar.contains(to) || to === target)) return;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 150);
    });
    bar.addEventListener('pointerleave', () => { hideTimer = setTimeout(hide, 150); });
    bar.addEventListener('pointerenter', () => clearTimeout(hideTimer));
    document.getElementById('chat')?.addEventListener('scroll', hide, { passive: true });

    // Touch: long-press any generated image to open the viewer with all actions.
    const chatEl = document.getElementById('chat');
    if (chatEl) {
        onLongPress(chatEl, (img) => viewChatElement(img), { selector: SELECTOR });
    }
}
