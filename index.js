/*
 * Revamped Image Gen — inline image & video generation for SillyTavern, with
 * a mobile-first Studio panel.
 *
 * Copyright (C) 2026 howardsierra
 *
 * Based on notsosillynotsoimages by aceeenvw
 *   https://github.com/aceeenvw/notsosillynotsoimages
 * Original: SillyImages by 0xl0cal
 *   https://github.com/0xl0cal/sillyimages
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed in the hope that it
 * will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty
 * of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 * General Public License for more details: <https://www.gnu.org/licenses/>.
 */

import * as chat from './src/chat.js';
import { DISPLAY_NAME, VERSION } from './src/constants.js';
import { installHistoryCompaction, updateInjection } from './src/prompt.js';
import { clearRefCache } from './src/refs.js';
import * as queue from './src/queue.js';
import { installFlushOnHide, legacySettings, onSettingsChange, save, settings } from './src/settings.js';
import { ctx, log, toast } from './src/st.js';
import { runStudio } from './src/studio.js';
import { ensureValidModel } from './src/model-list.js';
import { learnModelSizes } from './src/models.js';
import { viewChatElement } from './src/ui/actions.js';
import { h, icon } from './src/ui/dom.js';
import { openEditor } from './src/ui/editor.js';
import { openDiagnostics } from './src/ui/diagnose-ui.js';
import { installHover } from './src/ui/hover.js';
import * as panel from './src/ui/panel.js';
import { createTab } from './src/ui/tab-create.js';
import { createGalleryTab } from './src/ui/tab-gallery.js';
import { createQueueTab } from './src/ui/tab-queue.js';
import { createRefsTab } from './src/ui/tab-refs.js';
import { createSettingsTab } from './src/ui/tab-settings.js';

const tabsById = {};

function buildPanel() {
    const create = createTab({ show: (id) => panel.show(id) });
    const tabs = [
        create,
        createQueueTab(),
        createGalleryTab({ setPrompt: (item) => { panel.show('create'); create.setPrompt(item); } }),
        createRefsTab(),
        createSettingsTab(),
    ];
    for (const t of tabs) {
        panel.registerTab(t);
        tabsById[t.id] = t;
    }
    panel.mountPanel();
}

/** Compact block in the Extensions drawer — the real UI lives in the panel. */
function buildDrawer() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const enabled = h('input', {
        type: 'checkbox', checked: settings().enabled,
        onchange: () => { settings().enabled = enabled.checked; save('enabled'); updateInjection(); },
    });
    const drawer = h('div.iig-drawer.inline-drawer', {},
        h('div.inline-drawer-toggle.inline-drawer-header', {},
            h('b', {}, `${DISPLAY_NAME}`),
            h('div.inline-drawer-icon.fa-solid.fa-circle-chevron-down.down'),
        ),
        h('div.inline-drawer-content', {},
            h('label.checkbox_label', {}, enabled, h('span', {}, 'Enabled')),
            h('button.menu_button.iig-drawer-open', { type: 'button', onclick: () => panel.open() }, icon('palette'), ' Open Image Studio'),
            h('small', {}, `v${VERSION} · Shortcut: Alt+I · Everything is configured in the Studio panel.`),
        ),
    );
    host.append(drawer);
    onSettingsChange((k) => { if (k === 'enabled' || k === 'all') enabled.checked = settings().enabled; });
}

/** Entry in the wand (extensions) menu next to the chat input. */
function buildWandItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const item = h('div.list-group-item.flex-container.flexGap5.interactable', { tabindex: '0', role: 'button', title: DISPLAY_NAME },
        h('div.fa-fw.fa-solid.fa-palette.extensionsMenuExtensionButton'),
        h('span', {}, 'Image Studio'),
    );
    item.addEventListener('click', () => panel.open());
    menu.append(item);
    const illustrate = h('div.list-group-item.flex-container.flexGap5.interactable', { tabindex: '0', role: 'button', title: 'Illustrate the latest message' },
        h('div.fa-fw.fa-solid.fa-wand-magic-sparkles.extensionsMenuExtensionButton'),
        h('span', {}, 'Illustrate last message'),
    );
    illustrate.addEventListener('click', () => chat.illustrateMessage().catch(e => toast.error(e.message)));
    menu.append(illustrate);
}

function registerSlashCommands() {
    const c = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = c;
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'iig',
            aliases: ['studio-gen'],
            helpString: 'Generate an image with Revamped Image Gen. Returns the saved file path. <code>/iig ar=16:9 insert=true a lighthouse at dusk</code>',
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({ name: 'ar', description: 'aspect ratio, e.g. 16:9', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'style', description: 'style text', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'size', description: '1K, 2K or 4K', typeList: [ARGUMENT_TYPE.STRING] }),
                SlashCommandNamedArgument.fromProps({ name: 'insert', description: 'append to the last message', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' }),
            ],
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'prompt', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
            callback: async (args, value) => {
                const data = { prompt: String(value || '').trim() };
                if (args.ar) data.aspect_ratio = String(args.ar);
                if (args.style) data.style = String(args.style);
                if (args.size) data.image_size = String(args.size).toUpperCase();
                const [job] = runStudio({ data });
                const item = await queue.waitFor(job.id);
                if (String(args.insert) === 'true') {
                    const id = chat.lastMessageId();
                    if (id != null) await chat.insertIntoMessage(id, { kind: 'image', data: item.data, path: item.src });
                }
                return item.src;
            },
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'iig-panel',
            helpString: 'Open the Image Studio panel. Optional tab: create, queue, gallery, refs, settings.',
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'tab', typeList: [ARGUMENT_TYPE.STRING] })],
            callback: (_, value) => { panel.open(String(value || '').trim() || undefined); return ''; },
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'iig-illustrate',
            helpString: 'Have the chat model write a prompt for a message (default: the last one) and generate it.',
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'message id', typeList: [ARGUMENT_TYPE.NUMBER] })],
            callback: async (_, value) => {
                const id = value === '' || value == null ? undefined : Number(value);
                await chat.illustrateMessage(id);
                return '';
            },
        }));
    } catch (e) {
        log('warn', `Slash commands not registered: ${e.message}`);
    }
}

function wireEvents() {
    const c = ctx();
    const ev = c.eventTypes || c.event_types;
    const on = (name, fn) => { if (name) c.eventSource.on(name, fn); };

    // Run after other extensions (formatters, regex) have touched the message.
    const onRendered = (mesId) => {
        try {
            chat.processMessage(Number(mesId));
        } catch (e) {
            log('error', `processMessage failed: ${e.message}`);
        }
    };
    if (typeof c.eventSource.makeLast === 'function') c.eventSource.makeLast(ev.CHARACTER_MESSAGE_RENDERED, onRendered);
    else on(ev.CHARACTER_MESSAGE_RENDERED, onRendered);

    const redecorate = (mesId) => {
        if (mesId === undefined || mesId === null || Number.isNaN(Number(mesId))) chat.decorateAll();
        else {
            chat.reattach(Number(mesId));
            chat.decorateMessage(Number(mesId));
        }
    };
    on(ev.MESSAGE_UPDATED, redecorate);
    on(ev.MESSAGE_EDITED, redecorate);
    on(ev.MESSAGE_SWIPED, redecorate);
    on(ev.USER_MESSAGE_RENDERED, redecorate);
    on(ev.MORE_MESSAGES_LOADED, () => chat.decorateAll());

    let chatTimer = null;
    on(ev.CHAT_CHANGED, () => {
        clearRefCache();
        updateInjection();
        clearTimeout(chatTimer);
        chatTimer = setTimeout(async () => {
            chat.decorateAll();
            await chat.applyPendingFixups().catch(e => log('warn', `Pending fixups failed: ${e.message}`));
            for (const t of Object.values(tabsById)) t.refresh?.();
        }, 250);
    });

    onSettingsChange((key) => {
        if (['inject', 'injectTemplate', 'injectDepth', 'injectMax', 'refs', 'enabled', 'all'].includes(key)) updateInjection();
    });
}

function exposeApi() {
    try {
        window.RevampedImageGen = Object.freeze({
            version: VERSION,
            open: (tab) => panel.open(tab),
            close: () => panel.close(),
            /** Generate from code: resolves to { src, prompt, ... }. */
            generate: async (prompt, opts = {}) => {
                const [job] = runStudio({ data: { prompt, ...opts } });
                return queue.waitFor(job.id);
            },
        });
    } catch { /* never block init */ }
}

function init() {
    settings();
    installFlushOnHide();
    queue.installWakeLock();
    buildPanel();
    buildDrawer();
    buildWandItem();
    chat.installChatHandlers({ openViewer: viewChatElement, openEditor, openDiagnose: () => openDiagnostics() });
    installHover();
    installHistoryCompaction();
    wireEvents();
    registerSlashCommands();
    exposeApi();
    updateInjection();
    chat.decorateAll();
    // Catch a stale or unavailable model before the first generation fails on it.
    learnModelSizes(settings().learnedSizes);
    setTimeout(() => { if (settings().enabled) ensureValidModel().catch(() => {}); }, 2500);
    log('info', `${DISPLAY_NAME} v${VERSION} ready`);
    if (legacySettings() && !settings()._importedLegacy && !settings().apiKey) {
        toast.info('Found notsosillynotsoimages settings — import them from Image Studio → Settings → Import.', { timeOut: 8000 });
    }
}

(function boot() {
    const c = ctx();
    const ev = c.eventTypes || c.event_types;
    let started = false;
    const start = () => {
        if (started) return;
        started = true;
        try {
            init();
        } catch (e) {
            console.error('[RIG] init failed', e);
            toast.error(`Failed to start: ${e.message}`);
        }
    };
    // APP_READY is sticky in ST: listeners added after it fired still run.
    c.eventSource.on(ev.APP_READY, start);
    // SillyTavern only emits APP_READY at the very end of a long chain of awaits;
    // if anything in it throws or stalls (an unreachable backend, another
    // extension's error) the event never comes. Extension settings are already
    // loaded by the time this module runs, so start anyway once the page is usable.
    setTimeout(() => {
        if (started || !document.getElementById('chat')) return;
        console.warn('[RIG] APP_READY not received after 10s; starting anyway');
        start();
    }, 10000);
})();
