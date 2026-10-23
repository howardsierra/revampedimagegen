/*
 * Revamped Image Gen — the Studio panel shell and the floating launcher.
 *
 * Layout adapts to the device:
 *   phone (narrow)        → bottom sheet with drag handle, half/full snap, swipe down to close
 *   tablet / desktop      → side drawer (left or right), drag the edge to resize
 * The on-screen keyboard is tracked with visualViewport so inputs stay visible.
 * Licensed under AGPL-3.0-or-later.
 */

import { DISPLAY_NAME } from '../constants.js';
import { getProvider } from '../providers.js';
import * as queue from '../queue.js';
import { save, settings, onSettingsChange } from '../settings.js';
import { IS_TOUCH } from '../st.js';
import { h, icon } from './dom.js';

const PHONE_MAX = 700;
const tabs = new Map();
let root;
let panel;
let body;
let nav;
let fab;
let current = null;
let isOpen = false;

export function getRoot() {
    return root;
}

export function registerTab(tab) {
    tabs.set(tab.id, tab);
}

function layoutMode() {
    const s = settings();
    if (s.dock === 'bottom') return 'sheet';
    if (s.dock === 'left' || s.dock === 'right') return innerWidth < 480 ? 'sheet' : s.dock;
    return innerWidth < PHONE_MAX ? 'sheet' : 'right';
}

function applyLayout() {
    if (!panel) return;
    const mode = layoutMode();
    panel.dataset.mode = mode;
    root.dataset.mode = mode;
    const s = settings();
    if (mode === 'sheet') {
        panel.dataset.snap = s.sheetSnap === 'full' ? 'full' : 'half';
        panel.style.removeProperty('--iig-w');
    } else {
        const w = Math.min(Math.max(320, Number(s.panelWidth) || 420), Math.round(innerWidth * 0.92));
        panel.style.setProperty('--iig-w', `${w}px`);
    }
    document.body.classList.toggle('iig-panel-open', isOpen);
    document.body.dataset.iigDock = isOpen ? mode : '';
}

function trackKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
        const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
        document.documentElement.style.setProperty('--iig-kb', `${Math.round(kb)}px`);
        document.documentElement.style.setProperty('--iig-vvh', `${Math.round(vv.height)}px`);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
}

// ---------------------------------------------------------------- sheet drag

function installSheetDrag(handleEls) {
    let startY = 0;
    let startH = 0;
    let dragging = false;
    let pointerId = null;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;

    const onDown = (e) => {
        if (panel.dataset.mode !== 'sheet' || e.button > 0) return;
        if (e.target.closest('button, input, select, textarea, a')) return;
        dragging = true;
        pointerId = e.pointerId;
        startY = lastY = e.clientY;
        lastT = performance.now();
        velocity = 0;
        startH = panel.getBoundingClientRect().height;
        panel.classList.add('is-dragging');
        try { e.currentTarget.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
    };
    const onMove = (e) => {
        if (!dragging || e.pointerId !== pointerId) return;
        const now = performance.now();
        velocity = (e.clientY - lastY) / Math.max(1, now - lastT);
        lastY = e.clientY;
        lastT = now;
        const hgt = Math.max(120, startH - (e.clientY - startY));
        panel.style.setProperty('--iig-drag-h', `${hgt}px`);
    };
    const onUp = (e) => {
        if (!dragging || e.pointerId !== pointerId) return;
        dragging = false;
        panel.classList.remove('is-dragging');
        const hgt = panel.getBoundingClientRect().height;
        panel.style.removeProperty('--iig-drag-h');
        const vh = window.visualViewport?.height || innerHeight;
        const moved = e.clientY - startY;
        if (Math.abs(moved) < 6) {
            // A tap on the handle toggles between half and full.
            setSnap(panel.dataset.snap === 'full' ? 'half' : 'full');
            return;
        }
        if (velocity > 0.9 || hgt < vh * 0.28) close();
        else if (velocity < -0.6 || hgt > vh * 0.72) setSnap('full');
        else setSnap('half');
    };
    for (const el of handleEls) {
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
    }
}

function setSnap(snap) {
    panel.dataset.snap = snap;
    settings().sheetSnap = snap;
    save('sheetSnap');
}

// ---------------------------------------------------------------- side resize

function installResize(handle) {
    let startX = 0;
    let startW = 0;
    let active = false;
    handle.addEventListener('pointerdown', (e) => {
        active = true;
        startX = e.clientX;
        startW = panel.getBoundingClientRect().width;
        try { handle.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        panel.classList.add('is-resizing');
    });
    handle.addEventListener('pointermove', (e) => {
        if (!active) return;
        const dx = e.clientX - startX;
        const w = panel.dataset.mode === 'left' ? startW + dx : startW - dx;
        const clamped = Math.min(Math.max(320, w), Math.round(innerWidth * 0.92));
        panel.style.setProperty('--iig-w', `${clamped}px`);
    });
    const end = () => {
        if (!active) return;
        active = false;
        panel.classList.remove('is-resizing');
        settings().panelWidth = Math.round(panel.getBoundingClientRect().width);
        save('panelWidth');
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', () => {
        settings().panelWidth = 420;
        save('panelWidth');
        applyLayout();
    });
}

// ---------------------------------------------------------------- FAB

function placeFab() {
    if (!fab) return;
    const s = settings();
    fab.hidden = !s.showFab || !s.enabled;
    const pos = s.fabPos || { side: 'right', y: null };
    fab.dataset.side = pos.side === 'left' ? 'left' : 'right';
    fab.classList.toggle('placed', pos.y != null);
    if (pos.y == null) fab.style.removeProperty('top');
    else {
        const y = Math.min(Math.max(pos.y, 0.08), 0.9) * innerHeight;
        fab.style.top = `${Math.round(y)}px`;
    }
}

function installFabDrag() {
    let start = null;
    let moved = false;
    fab.addEventListener('pointerdown', (e) => {
        start = { x: e.clientX, y: e.clientY, id: e.pointerId };
        moved = false;
        try { fab.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    });
    fab.addEventListener('pointermove', (e) => {
        if (!start || e.pointerId !== start.id) return;
        if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 8) return;
        moved = true;
        fab.classList.add('is-dragging');
        fab.style.top = `${e.clientY - fab.offsetHeight / 2}px`;
        fab.style.left = `${e.clientX - fab.offsetWidth / 2}px`;
        fab.style.right = 'auto';
    });
    const end = (e) => {
        if (!start) return;
        const wasMoved = moved;
        start = null;
        fab.classList.remove('is-dragging');
        if (!wasMoved) return;
        fab.style.removeProperty('left');
        fab.style.removeProperty('right');
        settings().fabPos = { side: e.clientX < innerWidth / 2 ? 'left' : 'right', y: (e.clientY - fab.offsetHeight / 2) / innerHeight };
        save('fabPos');
        placeFab();
    };
    fab.addEventListener('pointerup', end);
    fab.addEventListener('pointercancel', end);
    fab.addEventListener('click', (e) => {
        if (moved) { e.preventDefault(); moved = false; return; }
        toggle();
    });
}

function updateBadges() {
    const active = queue.activeCount();
    if (fab) {
        fab.classList.toggle('is-busy', active > 0);
        const badge = fab.querySelector('.iig-fab-badge');
        badge.textContent = active ? String(active) : '';
        badge.hidden = !active;
        fab.setAttribute('aria-label', active ? `${DISPLAY_NAME}: ${active} running` : `Open ${DISPLAY_NAME}`);
    }
    const qBadge = nav?.querySelector('[data-tab="queue"] .iig-tab-badge');
    if (qBadge) {
        qBadge.textContent = active ? String(active) : '';
        qBadge.hidden = !active;
    }
    const pill = panel?.querySelector('.iig-head-pill');
    if (pill) {
        pill.hidden = !active;
        pill.textContent = `${active} running`;
    }
}

function updateSubtitle() {
    const sub = panel?.querySelector('.iig-head-sub');
    if (!sub) return;
    const s = settings();
    const p = getProvider(s.provider);
    sub.textContent = s.enabled ? `${p.label}${s.model ? ` · ${s.model}` : ''}` : 'Disabled';
}

// ---------------------------------------------------------------- open / close / tabs

export function show(tabId) {
    const id = tabs.has(tabId) ? tabId : current || settings().lastTab || 'create';
    if (current !== id) {
        tabs.get(current)?.onHide?.();
        current = id;
        for (const [tid, t] of tabs) {
            const on = tid === id;
            t.el.hidden = !on;
            const btn = nav.querySelector(`[data-tab="${tid}"]`);
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
            btn.tabIndex = on ? 0 : -1;
        }
        settings().lastTab = id;
        save('lastTab');
        body.scrollTop = 0;
    }
    tabs.get(id)?.onShow?.();
}

export function open(tabId) {
    if (!panel) return;
    isOpen = true;
    panel.hidden = false;
    applyLayout();
    // Next frame so the slide-in transition runs.
    requestAnimationFrame(() => panel.classList.add('is-open'));
    show(tabId);
}

export function close() {
    if (!panel || !isOpen) return;
    isOpen = false;
    panel.classList.remove('is-open');
    applyLayout();
    tabs.get(current)?.onHide?.();
    setTimeout(() => { if (!isOpen) panel.hidden = true; }, 260);
}

export function toggle(tabId) {
    if (isOpen && (!tabId || tabId === current)) close();
    else open(tabId);
}

export function isPanelOpen() {
    return isOpen;
}

export function mountPanel() {
    root = h('div#iig-root.iig-root');

    const tabButtons = [...tabs.values()].map(t => h('button.iig-tab', {
        type: 'button', role: 'tab', dataset: { tab: t.id }, 'aria-controls': `iig-tab-${t.id}`, title: t.label,
        onclick: () => show(t.id),
    }, icon(t.icon), h('span.iig-tab-label', {}, t.label), h('span.iig-tab-badge', { hidden: true })));

    nav = h('nav.iig-tabs', { role: 'tablist', 'aria-label': 'Studio sections' }, tabButtons);
    nav.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        const ids = [...tabs.keys()];
        let i = ids.indexOf(current);
        if (e.key === 'ArrowLeft') i = (i - 1 + ids.length) % ids.length;
        if (e.key === 'ArrowRight') i = (i + 1) % ids.length;
        if (e.key === 'Home') i = 0;
        if (e.key === 'End') i = ids.length - 1;
        show(ids[i]);
        nav.querySelector(`[data-tab="${ids[i]}"]`).focus();
        e.preventDefault();
    });

    body = h('div.iig-body');
    for (const t of tabs.values()) {
        t.el.id = `iig-tab-${t.id}`;
        t.el.setAttribute('role', 'tabpanel');
        t.el.classList.add('iig-tabpanel');
        t.el.hidden = true;
        body.append(t.el);
    }

    const grab = h('div.iig-grab', { 'aria-hidden': 'true' }, h('span'));
    const head = h('header.iig-head', {},
        h('div.iig-head-title', {},
            h('div.iig-head-name', {}, icon('palette'), h('span', {}, 'Image Studio')),
            h('div.iig-head-sub', {}),
        ),
        h('span.iig-head-pill', { hidden: true }),
        h('button.iig-icon-btn.iig-dock-btn', {
            type: 'button', title: 'Move panel',
            onclick: () => {
                const order = ['auto', 'left', 'bottom'];
                const s = settings();
                s.dock = order[(order.indexOf(s.dock) + 1) % order.length] || 'auto';
                save('dock');
                applyLayout();
            },
        }, icon('table-columns')),
        h('button.iig-icon-btn', { type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onclick: close }, icon('xmark')),
    );

    const resizer = h('div.iig-resizer', { title: 'Drag to resize, double-click to reset', 'aria-hidden': 'true' });
    panel = h('aside.iig-panel', { 'aria-label': DISPLAY_NAME, hidden: true }, grab, head, nav, body, resizer);

    fab = h('button#iig-fab.iig-fab', { type: 'button', title: `${DISPLAY_NAME} (Alt+I)` },
        icon('palette'),
        h('span.iig-fab-ring', { 'aria-hidden': 'true' }),
        h('span.iig-fab-badge', { hidden: true }),
    );

    root.append(panel, fab);
    document.body.append(root);

    installSheetDrag([grab, head]);
    installResize(resizer);
    installFabDrag();
    trackKeyboard();

    window.addEventListener('resize', () => { applyLayout(); placeFab(); });
    document.addEventListener('keydown', (e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'i' || e.key === 'I' || e.code === 'KeyI')) {
            e.preventDefault();
            toggle();
        } else if (e.key === 'Escape' && isOpen && !document.querySelector('.iig-modal, .iig-viewer.is-open')) {
            if (panel.contains(document.activeElement) || !IS_TOUCH) close();
        }
    });

    queue.onQueue(updateBadges);
    onSettingsChange((key) => {
        if (['provider', 'model', 'enabled', 'profile', 'all', null].includes(key)) updateSubtitle();
        if (['showFab', 'enabled', 'fabPos', 'all'].includes(key)) placeFab();
        if (key === 'dock') applyLayout();
    });

    updateSubtitle();
    updateBadges();
    placeFab();
    applyLayout();
}
