// Minimal stand-in for SillyTavern's getContext() so the extension can run in a plain page.

const toastHost = document.getElementById('toasts');
const mkToast = (cls) => (msg) => {
    const t = document.createElement('div');
    t.className = `toast ${cls}`;
    t.innerHTML = String(msg);
    toastHost.append(t);
    setTimeout(() => t.remove(), 3500);
};
window.toastr = { info: mkToast('info'), success: mkToast('success'), warning: mkToast('warning'), error: mkToast('error') };

class Emitter {
    constructor() { this.l = {}; this.fired = new Set(); }
    on(e, fn) { (this.l[e] ||= []).push(fn); if (this.fired.has(e) && e === 'app_ready') fn(); }
    makeLast(e, fn) { this.on(e, fn); }
    async emit(e, ...a) { if (e === 'app_ready') this.fired.add(e); for (const fn of this.l[e] || []) await fn(...a); }
}

const event_types = {
    APP_READY: 'app_ready', CHAT_CHANGED: 'chat_id_changed', CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    USER_MESSAGE_RENDERED: 'user_message_rendered', MESSAGE_UPDATED: 'message_updated', MESSAGE_EDITED: 'message_edited',
    MESSAGE_SWIPED: 'message_swiped', MORE_MESSAGES_LOADED: 'more_messages_loaded',
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready', GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
};

const origin = location.origin;
const extensionSettings = {
    revamped_image_gen: {
        provider: 'openai', endpoint: `${origin}/mock`, apiKey: 'test-key', model: 'mock-image-1',
        refs: { char: { name: 'Elodie, Lodi', path: '', always: false }, user: { name: '', path: '', always: false }, npcs: [] },
    },
};

const chat = [
    { name: 'You', is_user: true, mes: 'We finally reach the lighthouse. What do you see?' },
    {
        name: 'Elodie', is_user: false,
        mes: `Elodie pushes the heavy door open and the lamp room floods with amber light.\n\n<img data-iig-instruction='{"style":"cinematic","prompt":"Elodie standing in a lighthouse lamp room at dusk, amber light, wind in her hair","aspect_ratio":"16:9","image_size":"1K"}' src="[IMG:GEN]">\n\nShe turns to you, smiling. "Look at the sea."\n\n<img data-iig-instruction='{"prompt":"close-up portrait of Lodi laughing, freckles, soft rim light","aspect_ratio":"3:4"}' src="[IMG:GEN]">`,
    },
];
chat.forEach(m => { m.swipes = [m.mes]; m.swipe_id = 0; });

const eventSource = new Emitter();
let chatId = 'Elodie - 2026-10-23';
const prompts = {};

function renderMessage(i) {
    const m = chat[i];
    let el = document.querySelector(`#chat .mes[mesid="${i}"]`);
    if (!el) {
        el = document.createElement('div');
        el.className = 'mes';
        el.setAttribute('mesid', String(i));
        el.innerHTML = `<div class="avatar"></div><div class="mes_block"><div class="ch_name"><span>${m.name}</span><div class="mes_buttons"><div class="extraMesButtons"></div></div></div><div class="mes_text"></div></div>`;
        document.getElementById('chat').append(el);
    }
    el.querySelector('.mes_text').innerHTML = m.mes.split(/\n{2,}/).map(p => `<p>${p}</p>`).join('');
}

window.SillyTavern = {
    getContext: () => ({
        chat, characters: [{ name: 'Elodie', avatar: 'elodie.png' }], characterId: 0, groupId: null, groups: [],
        name1: 'Robin', name2: 'Elodie', chatMetadata: ((window.__metas ||= {})[chatId] ||= {}), extensionSettings,
        eventSource, event_types, eventTypes: event_types,
        getCurrentChatId: () => chatId,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        saveSettingsDebounced: () => { window.__settingsSaves = (window.__settingsSaves || 0) + 1; },
        saveChat: async () => { window.__chatSaves = (window.__chatSaves || 0) + 1; },
        saveMetadata: async () => {},
        updateMessageBlock: (i) => renderMessage(i),
        setExtensionPrompt: (k, v, pos, depth) => { prompts[k] = { v, pos, depth }; },
        generateQuietPrompt: async () => 'Prompt: "Elodie leaning on the lighthouse railing at night, storm clouds, lantern glow, cinematic wide shot"',
    }),
};

window.harness = {
    chat, prompts, renderMessage,
    async addAiMessage(text) {
        chat.push({ name: 'Elodie', is_user: false, mes: text, swipes: [text], swipe_id: 0 });
        renderMessage(chat.length - 1);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat.length - 1);
    },
    async switchChat(id) {
        chatId = id;
        await eventSource.emit(event_types.CHAT_CHANGED, id);
    },
};

chat.forEach((_, i) => renderMessage(i));
await import('/scripts/extensions/third-party/revampedimagegen/index.js');
await eventSource.emit(event_types.APP_READY);
await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, 1);
window.harnessReady = true;
