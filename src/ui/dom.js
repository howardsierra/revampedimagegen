/*
 * Revamped Image Gen — tiny DOM helpers. Licensed under AGPL-3.0-or-later.
 */

/**
 * h('button#id.iig-btn.primary', { onclick, title }, 'Text', child)
 * Props: `class`, `style` (object or string), `dataset`, `on<event>`, any attribute.
 */
export function h(sel, props = {}, ...children) {
    const [head, ...classes] = sel.split('.');
    const [tag, id] = head.split('#');
    const el = document.createElement(tag || 'div');
    if (id) el.id = id;
    if (classes.length) el.className = classes.join(' ');
    if (props === null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
        children.unshift(props);
        props = {};
    }
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className += (el.className ? ' ' : '') + v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'value') continue; // applied after children (needed for <select>)
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
    }
    append(el, children);
    if (props.value !== undefined && props.value !== null) el.value = props.value;
    return el;
}

function append(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

/** Font Awesome icon (SillyTavern ships FA 6). */
export function icon(name, extra = '') {
    return h('i', { class: `fa-solid fa-${name} ${extra}`.trim(), 'aria-hidden': 'true' });
}

export function clear(el) {
    while (el.firstChild) el.firstChild.remove();
    return el;
}

export function fmtElapsed(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function fmtTime(t) {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Debounce helper. */
export function debounce(fn, ms) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

/** Copy text, with a fallback for non-secure contexts (LAN-hosted ST over http). */
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    }
}

/** Trigger a download (or the iOS share sheet when available). */
export async function downloadUrl(url, filename) {
    const name = filename || url.split('/').pop() || 'image.png';
    try {
        const blob = await (await fetch(url)).blob();
        const file = new File([blob], name, { type: blob.type });
        if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
            await navigator.share({ files: [file] });
            return;
        }
        const obj = URL.createObjectURL(blob);
        const a = h('a', { href: obj, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(obj), 4000);
    } catch (e) {
        if (e?.name === 'AbortError') return; // share sheet dismissed
        window.open(url, '_blank', 'noopener');
    }
}

/** A row of chip buttons acting as a single-select. Returns { el, set(value) }. */
export function chipSelect(options, value, onChange, { className = '', render } = {}) {
    const el = h(`div.iig-chips${className ? `.${className}` : ''}`, { role: 'radiogroup' });
    const buttons = options.map(opt => {
        const v = typeof opt === 'object' ? opt.value : opt;
        const label = typeof opt === 'object' ? opt.label : opt;
        const b = h('button.iig-chip', {
            type: 'button',
            role: 'radio',
            dataset: { value: v },
            title: typeof opt === 'object' && opt.title ? opt.title : label,
            onclick: () => { set(v); onChange(v); },
        }, render ? render(opt) : label);
        el.append(b);
        return b;
    });
    function set(v) {
        for (const b of buttons) {
            const on = b.dataset.value === String(v);
            b.classList.toggle('active', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
        }
    }
    set(value);
    return { el, set };
}

/** Labelled toggle switch. */
export function toggle(label, checked, onChange, hint) {
    const input = h('input', { type: 'checkbox', checked: !!checked, onchange: () => onChange(input.checked) });
    return h('label.iig-toggle', {},
        h('span.iig-toggle-text', {}, label, hint ? h('small', {}, hint) : null),
        input,
        h('span.iig-switch', { 'aria-hidden': 'true' }),
    );
}

let fieldSeq = 0;

/**
 * Labelled field wrapper. Single form controls are linked with for/id; groups
 * (chip rows, button sets) get a plain container — wrapping those in <label>
 * would make taps on the label or hint "click" the first button.
 */
export function field(label, control, hint) {
    const single = control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement;
    if (single && !control.id) control.id = `iig-f${++fieldSeq}`;
    const lab = single
        ? h('label.iig-field-label', { for: control.id }, label)
        : h('span.iig-field-label', { role: 'heading', 'aria-level': '4' }, label);
    return h('div.iig-field', { role: single ? null : 'group', 'aria-label': single ? null : label },
        lab, control, hint ? h('small.iig-hint', {}, hint) : null);
}

/** Collapsible section (native <details>, keyboard + screen-reader friendly). */
export function section(title, body, { open = false, iconName } = {}) {
    return h('details.iig-section', { open },
        h('summary', {}, iconName ? icon(iconName) : null, h('span', {}, title), icon('chevron-down', 'iig-caret')),
        h('div.iig-section-body', {}, body),
    );
}

/**
 * Long-press for touch/pen. `selector` limits it to matching descendants of `el`;
 * the native context menu (and the click that follows) is suppressed only for those.
 */
export function onLongPress(el, fn, { selector = null, ms = 450 } = {}) {
    let timer = null;
    let startX = 0;
    let startY = 0;
    let lastType = 'mouse';
    let fired = false;
    const match = (e) => (selector ? e.target.closest?.(selector) : el);
    el.addEventListener('pointerdown', (e) => {
        lastType = e.pointerType;
        fired = false;
        if (e.pointerType === 'mouse') return;
        const t = match(e);
        if (!t) return;
        startX = e.clientX;
        startY = e.clientY;
        timer = setTimeout(() => { timer = null; fired = true; fn(t, e); }, ms);
    });
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel(); });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => { if (lastType !== 'mouse' && match(e)) e.preventDefault(); });
    el.addEventListener('click', (e) => {
        if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
    }, true);
}
