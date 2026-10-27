/*
 * Revamped Image Gen — small shared UI pieces. Licensed under AGPL-3.0-or-later.
 */

import { IMAGE_SIZES } from '../constants.js';
import { modelCaps } from '../models.js';
import { settings } from '../settings.js';
import { chipSelect, h, icon } from './dom.js';

/** Chip content for an aspect ratio: a little shape drawn to scale, plus the label. */
export function ratioChip(opt) {
    const value = typeof opt === 'object' ? opt.value : opt;
    const [w, hh] = String(value).split(':').map(Number);
    const r = w / hh;
    const max = 16;
    const bw = r >= 1 ? max : Math.round(max * r);
    const bh = r >= 1 ? Math.round(max / r) : max;
    return [h('span.iig-ratio-shape', { style: { width: `${bw}px`, height: `${bh}px` }, 'aria-hidden': 'true' }), h('span', {}, value)];
}

/** Empty-state block. */
export function empty(iconName, title, text, action) {
    return h('div.iig-empty', {},
        h('div.iig-empty-icon', {}, icon(iconName)),
        h('div.iig-empty-title', {}, title),
        text ? h('p', {}, text) : null,
        action || null,
    );
}

/** Thumbnail tile for grids. */
export function tile(item, { onOpen, badge } = {}) {
    const media = item.kind === 'video'
        ? h('video', { src: item.src, muted: true, playsInline: true, preload: 'metadata' })
        : h('img', { src: item.src, alt: item.prompt || '', loading: 'lazy', decoding: 'async' });
    return h('button.iig-tile', { type: 'button', title: item.prompt || '', onclick: onOpen },
        media,
        item.kind === 'video' ? h('span.iig-tile-badge', {}, icon('film')) : null,
        badge ? h('span.iig-tile-badge.left', {}, badge) : null,
    );
}

/**
 * Resolution chips that follow the selected model: "Auto · 2K" plus only the
 * sizes that model can make. Call refresh() after the model changes.
 */
export function sizeChips(value, onChange) {
    const wrap = h('div.iig-size-chips');
    let current = value || 'auto';
    const draw = () => {
        const caps = modelCaps(settings().model);
        const sizes = caps.sizes.filter(x => IMAGE_SIZES.includes(x));
        if (current !== 'auto' && !sizes.includes(current)) current = 'auto';
        const opts = [{ value: 'auto', label: `Auto · ${caps.defaultSize || '1K'}`, title: `Use ${caps.label || 'the model'}'s default` }, ...sizes.map(x => ({ value: x, label: x }))];
        wrap.replaceChildren(chipSelect(opts, current, (v) => { current = v; onChange(v); }).el);
    };
    draw();
    return { el: wrap, refresh: draw, get value() { return current; } };
}
