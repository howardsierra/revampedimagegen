/*
 * Revamped Image Gen — full-screen media viewer.
 * Touch: pinch to zoom, double-tap to zoom, drag to pan, swipe left/right to
 * page, swipe down to close, tap to hide controls. Mouse/keyboard: wheel zoom,
 * arrows, Esc. Licensed under AGPL-3.0-or-later.
 */

import { copyText, h, icon, setChildren } from './dom.js';
import { toast } from '../st.js';

let el;
let stage;
let media;
let counter;
let caption;
let actionsBar;
let infoBox;
let items = [];
let index = 0;
let getActions = () => [];
let lastFocus = null;

// transform state
let scale = 1;
let tx = 0;
let ty = 0;
const pointers = new Map();
let gesture = null;
let lastTap = { t: 0, x: 0, y: 0 };
let tapTimer = null;

function build() {
    counter = h('span.iig-viewer-count');
    caption = h('div.iig-viewer-caption');
    actionsBar = h('div.iig-viewer-actions');
    infoBox = h('div.iig-viewer-info', { hidden: true });
    stage = h('div.iig-viewer-stage');
    el = h('div.iig-viewer', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Image viewer', hidden: true, tabindex: '-1' },
        stage,
        h('div.iig-viewer-top', {},
            counter,
            h('div.iig-viewer-top-actions', {},
                h('button.iig-icon-btn', { type: 'button', title: 'Details', 'aria-label': 'Details', onclick: toggleInfo }, icon('circle-info')),
                h('button.iig-icon-btn', { type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onclick: close }, icon('xmark')),
            ),
        ),
        h('button.iig-viewer-nav.prev', { type: 'button', 'aria-label': 'Previous', onclick: () => go(-1) }, icon('chevron-left')),
        h('button.iig-viewer-nav.next', { type: 'button', 'aria-label': 'Next', onclick: () => go(1) }, icon('chevron-right')),
        h('div.iig-viewer-bottom', {}, caption, infoBox, actionsBar),
    );
    document.getElementById('iig-root').append(el);

    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('keydown', onKey);
}

function apply(animate = false) {
    if (!media) return;
    media.style.transition = animate ? 'transform .22s ease' : 'none';
    media.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    el.classList.toggle('is-zoomed', scale > 1.01);
}

function clampPan() {
    if (!media) return;
    const r = stage.getBoundingClientRect();
    const w = media.offsetWidth * scale;
    const hh = media.offsetHeight * scale;
    const maxX = Math.max(0, (w - r.width) / 2);
    const maxY = Math.max(0, (hh - r.height) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
}

function zoomAt(newScale, cx, cy) {
    const r = stage.getBoundingClientRect();
    const ox = cx - (r.left + r.width / 2);
    const oy = cy - (r.top + r.height / 2);
    const s = Math.min(6, Math.max(1, newScale));
    tx = ox - (ox - tx) * (s / scale);
    ty = oy - (oy - ty) * (s / scale);
    scale = s;
    if (scale === 1) { tx = 0; ty = 0; }
    clampPan();
}

function resetZoom(animate = true) {
    scale = 1;
    tx = 0;
    ty = 0;
    apply(animate);
}

function onDown(e) {
    if (e.target.closest('button, video')) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), scale, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    } else if (pointers.size === 1) {
        gesture = { type: 'pan', x: e.clientX, y: e.clientY, tx, ty, t: performance.now(), moved: false };
    }
}

function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;
    if (gesture.type === 'pinch' && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt(gesture.scale * (dist / gesture.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
        apply();
        return;
    }
    if (gesture.type === 'pan') {
        const dx = e.clientX - gesture.x;
        const dy = e.clientY - gesture.y;
        if (Math.hypot(dx, dy) > 6) gesture.moved = true;
        if (scale > 1.01) {
            tx = gesture.tx + dx;
            ty = gesture.ty + dy;
            clampPan();
            apply();
        } else if (gesture.moved) {
            // Not zoomed: follow the finger for swipe-to-page / swipe-down-to-close.
            const vertical = Math.abs(dy) > Math.abs(dx);
            gesture.axis = gesture.axis || (vertical ? 'y' : 'x');
            if (gesture.axis === 'y' && dy > 0) {
                media.style.transition = 'none';
                media.style.transform = `translate3d(0, ${dy}px, 0) scale(${1 - Math.min(dy / 1200, 0.25)})`;
                el.style.setProperty('--iig-viewer-dim', String(Math.max(0.2, 1 - dy / 500)));
            } else if (gesture.axis === 'x') {
                media.style.transition = 'none';
                media.style.transform = `translate3d(${dx}px, 0, 0)`;
            }
        }
    }
}

function onUp(e) {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.type === 'pinch') {
        if (pointers.size < 2) {
            gesture = null;
            if (scale < 1.05) resetZoom();
        }
        return;
    }
    if (gesture.type !== 'pan' || !p) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    const dt = performance.now() - gesture.t;
    const g = gesture;
    gesture = null;
    el.style.removeProperty('--iig-viewer-dim');

    if (!g.moved && dt < 300) {
        handleTap(e.clientX, e.clientY);
        return;
    }
    if (scale > 1.01) return;
    const fast = dt < 300;
    if (g.axis === 'y' && (dy > 120 || (fast && dy > 50))) { close(); return; }
    if (g.axis === 'x' && (Math.abs(dx) > 80 || (fast && Math.abs(dx) > 40)) && items.length > 1) {
        go(dx < 0 ? 1 : -1);
        return;
    }
    resetZoom();
}

function handleTap(x, y) {
    const now = performance.now();
    if (now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
        clearTimeout(tapTimer);
        lastTap.t = 0;
        if (scale > 1.01) resetZoom();
        else { zoomAt(2.5, x, y); apply(true); }
        return;
    }
    lastTap = { t: now, x, y };
    clearTimeout(tapTimer);
    // Single tap: toggle the controls so the image can be seen unobstructed.
    tapTimer = setTimeout(() => el.classList.toggle('chrome-hidden'), 280);
}

function onWheel(e) {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
    zoomAt(scale * factor, e.clientX, e.clientY);
    apply();
}

function onKey(e) {
    if (e.target.closest('textarea, input')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === '+' || e.key === '=') { zoomAt(scale * 1.4, innerWidth / 2, innerHeight / 2); apply(true); }
    else if (e.key === '-') { zoomAt(scale / 1.4, innerWidth / 2, innerHeight / 2); apply(true); }
    else if (e.key === '0') resetZoom();
}

function toggleInfo() {
    infoBox.hidden = !infoBox.hidden;
}

function renderInfo(item) {
    const d = item.data || {};
    const rows = [
        ['Prompt', item.prompt || d.prompt],
        ['Style', d.style],
        ['Aspect', d.aspect_ratio],
        ['Size', d.image_size],
        ['Model', item.model],
        ['References', item.refs?.length ? item.refs.join(', ') : null],
        ['File', item.src],
    ].filter(([, v]) => v);
    setChildren(infoBox, 
        ...rows.map(([k, v]) => h('div.iig-info-row', {}, h('span.k', {}, k), h('span.v', {}, String(v)))),
        h('button.iig-btn.small', { type: 'button', onclick: async () => { if (await copyText(item.prompt || d.prompt || '')) toast.success('Prompt copied'); } }, icon('copy'), ' Copy prompt'),
    );
}

function render() {
    const item = items[index];
    if (!item) return;
    stage.replaceChildren();
    resetZoom(false);
    if (item.kind === 'video') {
        media = h('video.iig-viewer-media', { src: item.src, controls: true, autoplay: true, loop: true, playsInline: true });
        media.setAttribute('playsinline', '');
    } else {
        media = h('img.iig-viewer-media', { src: item.src, alt: item.prompt || '', draggable: false });
    }
    stage.append(media);
    counter.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
    caption.textContent = item.prompt || '';
    el.classList.toggle('single', items.length < 2);
    renderInfo(item);
    setChildren(actionsBar, ...getActions(item).map(a => h(`button.iig-viewer-act${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, {
        type: 'button',
        title: a.label,
        onclick: async () => {
            try {
                const keepOpen = await a.run(item, { close });
                if (keepOpen === 'refresh') render();
            } catch (err) {
                toast.error(err.message);
            }
        },
    }, icon(a.icon), h('span', {}, a.label))));
    // Warm the neighbours so paging feels instant.
    for (const n of [items[index + 1], items[index - 1]]) {
        if (n && n.kind !== 'video') { const pre = new Image(); pre.src = n.src; }
    }
}

function go(delta) {
    if (items.length < 2) { resetZoom(); return; }
    index = (index + delta + items.length) % items.length;
    render();
}

/**
 * Open the viewer.
 * @param {Array<{src:string, kind?:string, prompt?:string, data?:object}>} list
 * @param {number} start
 * @param {(item)=>Array<{icon:string,label:string,run:Function,primary?:boolean,danger?:boolean}>} actions
 */
export function openViewer(list, start = 0, actions = () => []) {
    if (!el) build();
    items = list.filter(i => i?.src);
    if (!items.length) return;
    index = Math.min(Math.max(0, start), items.length - 1);
    getActions = actions;
    lastFocus = document.activeElement;
    el.hidden = false;
    el.classList.remove('chrome-hidden');
    infoBox.hidden = true;
    render();
    requestAnimationFrame(() => {
        el.classList.add('is-open');
        el.focus();
    });
    document.documentElement.classList.add('iig-no-scroll');
}

export function close() {
    if (!el || el.hidden) return;
    el.classList.remove('is-open');
    document.documentElement.classList.remove('iig-no-scroll');
    const v = el.querySelector('video');
    v?.pause();
    setTimeout(() => {
        el.hidden = true;
        stage.replaceChildren();
        media = null;
    }, 200);
    lastFocus?.focus?.();
}

/** Replace the current item (e.g. after a regenerate finished) and re-render. */
export function updateCurrent(patch) {
    if (!items[index]) return;
    Object.assign(items[index], patch);
    render();
}

export function isViewerOpen() {
    return !!el && !el.hidden;
}
