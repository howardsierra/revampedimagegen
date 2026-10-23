/*
 * Revamped Image Gen — what you can do with a piece of media, shared by the
 * chat, gallery and studio views. Licensed under AGPL-3.0-or-later.
 */

import * as chat from '../chat.js';
import { deleteFile } from '../storage.js';
import { runStudio, removeFromHistory } from '../studio.js';
import { toast, IS_TOUCH } from '../st.js';
import { copyText, downloadUrl } from './dom.js';
import { openEditor, confirmDialog } from './editor.js';
import { openViewer } from './viewer.js';
import { openRefPicker } from './ref-picker.js';
import * as panel from './panel.js';

const download = { icon: 'download', label: 'Save', run: (item) => downloadUrl(item.src) };
const asRef = { icon: 'user-check', label: 'Use as ref', run: (item) => openRefPicker(item) };
const copy = {
    icon: 'copy', label: 'Copy prompt', run: async (item) => {
        if (await copyText(item.prompt || '')) toast.success('Prompt copied');
    },
};

function closeAll(close) {
    close();
    // On phones the sheet covers the chat; get out of the way so the result is visible.
    if (IS_TOUCH && innerWidth < 700) panel.close();
}

export function chatItemActions(item) {
    const isError = /error\.svg/i.test(item.src);
    const regen = (dataOverride, close) => {
        const job = item.el?.isConnected
            ? chat.regenerateElement(item.el, dataOverride)
            : chat.regenerateBySrc(item.mesId, item.src, dataOverride);
        if (job) {
            toast.info(isError ? 'Retrying…' : 'Regenerating…');
            closeAll(close);
        }
    };
    const list = [
        { icon: 'rotate-right', label: isError ? 'Retry' : 'Regenerate', primary: true, run: (_, { close }) => regen(null, close) },
        {
            icon: 'pen', label: 'Edit & redo', run: (_, { close }) => openEditor({
                title: isError ? 'Edit & retry' : 'Edit & regenerate',
                kind: item.kind,
                data: item.data || { prompt: item.prompt },
                onSubmit: (data) => regen(data, close),
            }),
        },
        { icon: 'location-crosshairs', label: 'Go to message', run: (_, { close }) => { closeAll(close); chat.jumpToMessage(item.mesId); } },
    ];
    if (!isError && item.kind !== 'video') list.push(asRef);
    if (!isError) list.push(download);
    list.push(copy);
    if (!isError) {
        list.push({
            icon: 'trash', label: 'Remove', danger: true, run: async (_, { close }) => {
                if (!await confirmDialog('Remove this image from the message and delete the file?', { okLabel: 'Remove', danger: true })) return;
                await chat.removeMedia(item.mesId, item.src, deleteFile);
                close();
                toast.success('Removed');
            },
        });
    }
    return list;
}

export function studioItemActions(item, { usePrompt } = {}) {
    return [
        {
            icon: 'message', label: 'Add to chat', primary: true, run: async (_, { close }) => {
                const id = chat.lastMessageId();
                if (id == null) throw new Error('Open a chat first');
                await chat.insertIntoMessage(id, { kind: item.kind, data: item.data || { prompt: item.prompt }, path: item.src });
                toast.success('Added to the last message');
                closeAll(close);
            },
        },
        {
            icon: 'shuffle', label: 'Remix', run: () => openEditor({
                title: 'Remix', kind: item.kind, data: item.data || { prompt: item.prompt },
                onSubmit: (data) => { runStudio({ kind: item.kind, data }); toast.info('Queued'); },
            }),
        },
        usePrompt ? { icon: 'arrow-up-from-bracket', label: 'Use prompt', run: (_, { close }) => { usePrompt(item); close(); } } : null,
        item.kind !== 'video' ? asRef : null,
        download,
        copy,
        {
            icon: 'trash', label: 'Delete', danger: true, run: async (_, { close }) => {
                if (!await confirmDialog('Delete this image from the studio history and the server?', { okLabel: 'Delete', danger: true })) return;
                removeFromHistory(item.src);
                await deleteFile(item.src);
                close();
            },
        },
    ].filter(Boolean);
}

/** Open the viewer on a rendered chat image, paging through every image in that message. */
export function viewChatElement(el) {
    const mes = el.closest('.mes');
    const mesId = Number(mes?.getAttribute('mesid'));
    const els = [...(mes?.querySelectorAll('.mes_text img.iig-img, .mes_text img.iig-img-error') || [])];
    const items = els.map(e => {
        const found = chat.tagForElement(e);
        return {
            el: e,
            src: e.getAttribute('src'),
            kind: 'image',
            mesId,
            prompt: found?.tag.data.prompt || e.alt || '',
            data: found?.tag.data,
        };
    });
    openViewer(items, Math.max(0, els.indexOf(el)), chatItemActions);
}
