/*
 * Revamped Image Gen — Settings tab. Licensed under AGPL-3.0-or-later.
 */

import { ASPECT_RATIOS, DEFAULT_INJECT_TEMPLATE, DEFAULT_STYLES, DISPLAY_NAME, IMAGE_SIZES, VERSION, VIDEO_RESOLUTIONS } from '../constants.js';
import { PROVIDERS, getProvider, normalizeNaisteraModel } from '../providers.js';
import { renderInjection, updateInjection } from '../prompt.js';
import { clearRefCache } from '../refs.js';
import { applyProfile, importLegacy, legacySettings, save, settings, snapshotProfile, updateActiveProfile } from '../settings.js';
import { logsAsText, onLog, toast } from '../st.js';
import { chipSelect, copyText, debounce, field, h, icon, section, toggle } from './dom.js';
import { confirmDialog } from './editor.js';
import { ratioChip } from './widgets.js';

export function createSettingsTab() {
    const el = h('section');
    let visible = false;

    const text = (key, { placeholder = '', type = 'text', onAfter, ...rest } = {}) => {
        const input = h('input.iig-input', {
            type, value: settings()[key] ?? '', placeholder, autocomplete: 'off', spellcheck: 'false', ...rest,
            oninput: debounce(() => {
                settings()[key] = type === 'number' ? Number(input.value) : input.value;
                save(key);
                onAfter?.(input.value);
            }, 300),
        });
        return input;
    };
    const area = (key, rows = 4, onAfter) => {
        const t = h('textarea.iig-input', {
            rows, value: settings()[key] ?? '',
            oninput: debounce(() => { settings()[key] = t.value; save(key); onAfter?.(); }, 300),
        });
        return t;
    };
    const flag = (key, label, hint, onAfter) => toggle(label, settings()[key], (v) => { settings()[key] = v; save(key); onAfter?.(v); }, hint);
    const select = (key, options, onAfter) => {
        const sel = h('select.iig-input', {
            value: settings()[key],
            onchange: () => { settings()[key] = sel.value; save(key); onAfter?.(sel.value); },
        }, options.map(o => h('option', { value: typeof o === 'object' ? o.value : o }, typeof o === 'object' ? o.label : o)));
        sel.value = settings()[key];
        return sel;
    };

    // ------------------------------------------------------------ connection

    function connectionSection() {
        const s = settings();
        const provider = getProvider(s.provider);

        const profileSel = h('select.iig-input', {
            'aria-label': 'Connection profile',
            onchange: () => {
                if (profileSel.value && applyProfile(profileSel.value)) {
                    toast.success('Profile loaded');
                    render();
                }
            },
        }, h('option', { value: '' }, s.profiles.length ? '— Choose a profile —' : 'No saved profiles'),
        s.profiles.map(p => h('option', { value: p.id }, p.name)));
        profileSel.value = s.activeProfileId && s.profiles.some(p => p.id === s.activeProfileId) ? s.activeProfileId : '';

        const profileRow = h('div.iig-row.wrap', {},
            h('button.iig-btn.small', {
                type: 'button', onclick: () => {
                    const name = prompt('Profile name', getProvider(settings().provider).label);
                    if (!name?.trim()) return;
                    const p = snapshotProfile(name.trim());
                    settings().profiles.push(p);
                    settings().activeProfileId = p.id;
                    save('profile');
                    render();
                    toast.success('Profile saved');
                },
            }, icon('floppy-disk'), h('span', {}, 'Save as…')),
            s.activeProfileId ? h('button.iig-btn.small', { type: 'button', onclick: () => { if (updateActiveProfile()) toast.success('Profile updated'); } }, icon('arrows-rotate'), h('span', {}, 'Update')) : null,
            s.activeProfileId ? h('button.iig-btn.small.ghost.danger', {
                type: 'button', onclick: async () => {
                    const p = settings().profiles.find(x => x.id === settings().activeProfileId);
                    if (!p || !await confirmDialog(`Delete profile "${p.name}"?`, { okLabel: 'Delete', danger: true })) return;
                    settings().profiles = settings().profiles.filter(x => x.id !== p.id);
                    settings().activeProfileId = '';
                    save('profile');
                    render();
                },
            }, icon('trash')) : null,
        );

        const providerSel = select('provider', Object.values(PROVIDERS).map(p => ({ value: p.id, label: p.label })), () => render());

        const key = text('apiKey', { type: 'password', placeholder: provider.keyRequired ? 'Required' : 'Optional' });
        const eye = h('button.iig-icon-btn', {
            type: 'button', 'aria-label': 'Show key', onclick: () => {
                key.type = key.type === 'password' ? 'text' : 'password';
                eye.replaceChildren(icon(key.type === 'password' ? 'eye' : 'eye-slash'));
            },
        }, icon('eye'));

        const modelList = h('datalist', { id: 'iig-model-list' });
        const model = text('model', { placeholder: provider.supportsModels ? 'Type or fetch…' : '', list: 'iig-model-list' });
        const modelPick = h('div.iig-model-pick', { hidden: true });
        const fetchBtn = h('button.iig-btn.small', {
            type: 'button', onclick: async () => {
                fetchBtn.disabled = true;
                fetchBtn.classList.add('is-busy');
                try {
                    const list = await getProvider(settings().provider).listModels(settings());
                    const imageish = list.filter(m => /image|dall-e|flux|imagen|banana|sdxl|stable|diffusion|seedream|ideogram|recraft|kolors|hidream|midjourney|qwen|grok|gpt-5|veo|sora|kling|wan|seedance/i.test(m));
                    const shown = (imageish.length ? imageish : list).slice(0, 300);
                    modelList.replaceChildren(...shown.map(m => h('option', { value: m })));
                    modelPick.hidden = !shown.length;
                    modelPick.replaceChildren(...shown.map(m => h('button.iig-chip', {
                        type: 'button', onclick: () => {
                            model.value = m;
                            settings().model = m;
                            save('model');
                            for (const b of modelPick.children) b.classList.toggle('active', b.textContent === m);
                        },
                    }, m)));
                    toast.success(`Found ${list.length} model${list.length === 1 ? '' : 's'}${imageish.length && imageish.length !== list.length ? ` (${imageish.length} look image-capable)` : ''}`);
                } catch (e) {
                    toast.error(`Could not list models: ${e.message}`);
                } finally {
                    fetchBtn.disabled = false;
                    fetchBtn.classList.remove('is-busy');
                }
            },
        }, icon('list'), h('span', {}, 'Fetch'));

        const providerExtras = [];
        if (provider.id === 'naistera') {
            const nm = h('select.iig-input', {
                onchange: () => { settings().naisteraModel = nm.value; save('naisteraModel'); },
            }, provider.models.map(m => h('option', { value: m }, m.replace(/\b\w/g, c => c.toUpperCase()))));
            nm.value = normalizeNaisteraModel(s.naisteraModel);
            providerExtras.push(field('Naistera model', nm), field('Preset (Grok only)', select('naisteraPreset', [{ value: '', label: 'None' }, { value: 'digital', label: 'Digital' }, { value: 'realism', label: 'Realism' }])));
        }
        if (provider.id === 'openai') {
            providerExtras.push(field('Reference images via', select('openaiRefMode', [
                { value: 'auto', label: 'Auto (multipart for api.openai.com, JSON elsewhere)' },
                { value: 'json', label: 'JSON body.image (aggregators)' },
                { value: 'multipart', label: 'Multipart /v1/images/edits (OpenAI)' },
            ])));
        }
        if (provider.id === 'sdwebui') {
            providerExtras.push(h('div.iig-row-3', {},
                field('Steps', text('sdSteps', { type: 'number', min: 1, max: 150 })),
                field('CFG', text('sdCfg', { type: 'number', step: 0.5, min: 1, max: 30 })),
                field('Sampler', text('sdSampler')),
            ));
        }

        const testBtn = h('button.iig-btn.small', {
            type: 'button', onclick: async () => {
                const p = getProvider(settings().provider);
                testBtn.disabled = true;
                testBtn.classList.add('is-busy');
                try {
                    if (p.keyRequired && !settings().apiKey) throw new Error('No API key set');
                    if (!p.listModels) {
                        toast.info(`${p.label} has no test endpoint — try a generation from the Create tab.`);
                        return;
                    }
                    const list = await p.listModels(settings());
                    const m = settings().model;
                    if (m && list.length && !list.includes(m)) toast.warn(`Connected, but "${m}" is not in the provider's model list.`);
                    else toast.success(`Connected${list.length ? ` — ${list.length} models available` : ''}`);
                } catch (e) {
                    const st = e.status;
                    toast.error(st === 401 || st === 403 ? 'Authentication rejected — check the API key.' : st === 404 ? 'Reached the server but the path was not found — check the endpoint URL.' : e.message);
                } finally {
                    testBtn.disabled = false;
                    testBtn.classList.remove('is-busy');
                }
            },
        }, icon('plug'), h('span', {}, 'Test'));

        return section('Connection', [
            field('Profile', h('div.iig-stack', {}, profileSel, profileRow), 'Save complete provider setups and switch with one tap.'),
            field('API type', providerSel, provider.hint),
            field('Endpoint URL', text('endpoint', { type: 'url', placeholder: provider.defaultEndpoint || 'https://…', inputmode: 'url' }), 'Base URL only. Include any documented prefix such as /v1 or /compatible.'),
            field('API key', h('div.iig-input-group', {}, key, eye), 'Stored in SillyTavern\'s settings.json and masked in logs.'),
            provider.supportsModels || provider.id !== 'naistera'
                ? field('Model', h('div.iig-stack', {}, h('div.iig-input-group', {}, model, provider.supportsModels ? fetchBtn : null), modelPick, modelList))
                : null,
            ...providerExtras,
            provider.supportsRefs ? flag('sendRefs', 'Send reference images', 'Turn off for providers that reject image input') : null,
            flag('useCorsProxy', 'Route through ST CORS proxy', 'For providers that block browser requests. Needs enableCorsProxy: true in config.yaml.'),
            h('details.iig-more', {}, h('summary', {}, 'Advanced'),
                field('Path override', text('pathOverride', { placeholder: 'e.g. /api/v2/images or /v1beta/models/{model}:generateContent' }), 'Replaces the auto-appended path. Leave empty normally.'),
                field('Request timeout (seconds)', text('timeoutSec', { type: 'number', min: 30, max: 1800 })),
            ),
            h('div.iig-row', {}, testBtn),
        ], { open: !s.apiKey && provider.keyRequired, iconName: 'plug' });
    }

    // ------------------------------------------------------------ defaults & styles

    function defaultsSection() {
        const s = settings();
        const ar = chipSelect(ASPECT_RATIOS, s.aspectRatio, (v) => { settings().aspectRatio = v; save('aspectRatio'); }, { className: 'iig-chips-scroll', render: ratioChip });
        const size = chipSelect(IMAGE_SIZES, s.imageSize, (v) => { settings().imageSize = v; save('imageSize'); });
        return section('Image defaults', [
            flag('tagOverrides', 'Let the AI\'s tag choose style & size', 'Off: your defaults below always win (aspect ratio still follows the tag)'),
            field('Default style', text('defaultStyle', { placeholder: 'e.g. semi-realistic digital painting', list: 'iig-style-list' })),
            field('Aspect ratio (when the tag has none)', ar.el),
            field('Resolution', size.el),
            field('Quality (OpenAI)', select('quality', ['auto', 'low', 'medium', 'high', 'standard', 'hd'])),
            h('div.iig-row-2', {}, field('Prompt prefix', text('promptPrefix', { placeholder: 'Added before every chat prompt' })), field('Prompt suffix', text('promptSuffix', { placeholder: 'Added after' }))),
            field('Negative prompt', text('negativePrompt', { placeholder: 'Used where supported (SD WebUI, some aggregators)' })),
        ], { iconName: 'sliders' });
    }

    function stylesSection() {
        const list = h('div.iig-stack');
        const draw = () => {
            const styles = settings().styles;
            list.replaceChildren(...styles.map((st, i) => {
                const name = h('input.iig-input.narrow', { type: 'text', value: st.name, 'aria-label': 'Style name', oninput: debounce(() => { st.name = name.value; save('styles'); }, 300) });
                const val = h('input.iig-input', { type: 'text', value: st.value, 'aria-label': 'Style text', oninput: debounce(() => { st.value = val.value; save('styles'); }, 300) });
                return h('div.iig-style-row', {}, name, val, h('button.iig-icon-btn', { type: 'button', 'aria-label': 'Delete style', onclick: () => { styles.splice(i, 1); save('styles'); draw(); } }, icon('trash')));
            }));
        };
        draw();
        return section('Style library', [
            h('p.iig-muted.small', {}, 'One-tap styles on the Create tab and in the prompt editor.'),
            list,
            h('div.iig-row.wrap', {},
                h('button.iig-btn.small', { type: 'button', onclick: () => { settings().styles.push({ name: 'New', value: '' }); save('styles'); draw(); } }, icon('plus'), h('span', {}, 'Add style')),
                h('button.iig-btn.small.ghost', { type: 'button', onclick: () => { settings().styles = DEFAULT_STYLES.map(x => ({ ...x })); save('styles'); draw(); } }, icon('rotate-left'), h('span', {}, 'Restore defaults')),
            ),
        ], { iconName: 'swatchbook' });
    }

    // ------------------------------------------------------------ AI instructions

    function instructionsSection() {
        const preview = h('pre.iig-pre', { hidden: true });
        const refreshPreview = () => { if (!preview.hidden) preview.textContent = renderInjection(); updateInjection(); };
        const tpl = area('injectTemplate', 9, refreshPreview);
        return section('AI instructions', [
            flag('inject', 'Teach the chat model to write image tags', 'Injects the template below into every prompt — no preset editing needed', () => updateInjection()),
            h('div.iig-row-2', {},
                field('Insert depth', text('injectDepth', { type: 'number', min: 0, max: 50, onAfter: () => updateInjection() }), '0 = after the last message'),
                field('Max images per reply', text('injectMax', { type: 'number', min: 1, max: 6, onAfter: refreshPreview })),
            ),
            field('Template', tpl, '{{iig_names}} → names with reference photos, {{iig_max}} → the limit above. ST macros like {{char}} work too.'),
            h('div.iig-row.wrap', {},
                h('button.iig-btn.small', { type: 'button', onclick: () => { preview.hidden = !preview.hidden; refreshPreview(); } }, icon('eye'), h('span', {}, 'Preview')),
                h('button.iig-btn.small.ghost', { type: 'button', onclick: () => { settings().injectTemplate = DEFAULT_INJECT_TEMPLATE; tpl.value = DEFAULT_INJECT_TEMPLATE; save('injectTemplate'); refreshPreview(); } }, icon('rotate-left'), h('span', {}, 'Reset')),
            ),
            preview,
            flag('compactHistory', 'Shorten old image tags in the prompt', 'Replaces finished tags with a one-line note. Saves tokens; stops the model copying file paths.'),
        ], { iconName: 'robot' });
    }

    // ------------------------------------------------------------ video, behaviour, device

    function videoSection() {
        const s = settings();
        const res = chipSelect(VIDEO_RESOLUTIONS, s.videoResolution, (v) => { settings().videoResolution = v; save('videoResolution'); });
        return section('Video (experimental)', [
            h('p.iig-muted.small', {}, 'Uses the same endpoint and key via /v1/video/generations (OpenAI- or Gemini-compatible aggregators). Leave the model empty to disable.'),
            field('Video model', text('videoModel', { placeholder: 'e.g. veo-3.1-fast, seedance-1-pro' })),
            h('div.iig-row-2', {}, field('Default duration (s)', text('videoDuration', { type: 'number', min: 1, max: 30 })), field('Resolution', res.el)),
            flag('videoAudio', 'Request an audio track'),
        ], { iconName: 'film' });
    }

    function behaviourSection() {
        return section('Behaviour', [
            flag('autoGenerate', 'Generate automatically', 'Off: tags in AI replies show a "Tap to generate" button instead'),
            h('div.iig-row-3', {},
                field('Parallel jobs', text('concurrency', { type: 'number', min: 1, max: 6 })),
                field('Retries', text('maxRetries', { type: 'number', min: 0, max: 6 })),
                field('Retry delay (ms)', text('retryDelay', { type: 'number', min: 250, step: 250 })),
            ),
            h('p.iig-muted.small', {}, 'Retries cover rate limits (429), server errors (5xx), timeouts and dropped connections, with exponential backoff.'),
        ], { iconName: 'gears' });
    }

    function deviceSection() {
        const notify = flag('notify', 'Notify when done in background', 'System notification if the tab is hidden', async (v) => {
            if (v && 'Notification' in window && Notification.permission === 'default') {
                const r = await Notification.requestPermission();
                if (r !== 'granted') toast.warn('Notifications were not allowed by the browser.');
            }
        });
        return section('Device & layout', [
            flag('showFab', 'Show floating button', 'Drag it anywhere; it shows a live count while images generate'),
            field('Panel position', select('dock', [
                { value: 'auto', label: 'Auto (sheet on phones, right side otherwise)' },
                { value: 'right', label: 'Right side' },
                { value: 'left', label: 'Left side' },
                { value: 'bottom', label: 'Bottom sheet' },
            ])),
            flag('hoverToolbar', 'Hover toolbar on chat images (mouse)'),
            flag('haptics', 'Vibrate on finish / error', 'Android only — iOS browsers do not expose vibration'),
            flag('wakeLock', 'Keep screen awake while generating', 'Stops phones from sleeping and dropping long requests'),
            notify,
        ], { iconName: 'mobile-screen' });
    }

    // ------------------------------------------------------------ maintenance

    function maintenanceSection() {
        const logBox = h('pre.iig-pre.iig-log', { hidden: true });
        let unsub = null;
        const legacy = legacySettings();
        return section('Import & diagnostics', [
            legacy ? h('div.iig-callout', {},
                h('div', {}, h('strong', {}, 'notsosillynotsoimages settings found.'), ' Import its connection, presets and character references (photos are reused, not re-uploaded).'),
                h('button.iig-btn.small.primary', {
                    type: 'button', onclick: async () => {
                        if (!await confirmDialog('Replace your current connection and references with the imported ones?', { okLabel: 'Import' })) return;
                        importLegacy();
                        clearRefCache();
                        updateInjection();
                        toast.success('Imported');
                        render();
                    },
                }, icon('file-import'), h('span', {}, settings()._importedLegacy ? 'Import again' : 'Import')),
            ) : null,
            h('div.iig-row.wrap', {},
                h('button.iig-btn.small', {
                    type: 'button', onclick: () => {
                        logBox.hidden = !logBox.hidden;
                        unsub?.();
                        unsub = null;
                        if (!logBox.hidden) {
                            logBox.textContent = logsAsText().split('\n').slice(-150).join('\n') || '(empty)';
                            logBox.scrollTop = logBox.scrollHeight;
                            unsub = onLog(() => { logBox.textContent = logsAsText().split('\n').slice(-150).join('\n'); logBox.scrollTop = logBox.scrollHeight; });
                        }
                    },
                }, icon('terminal'), h('span', {}, 'Show log')),
                h('button.iig-btn.small', { type: 'button', onclick: async () => { if (await copyText(logsAsText())) toast.success('Log copied (keys are masked)'); } }, icon('copy'), h('span', {}, 'Copy log')),
                h('button.iig-btn.small', {
                    type: 'button', onclick: () => {
                        const blob = new Blob([logsAsText()], { type: 'text/plain' });
                        const a = h('a', { href: URL.createObjectURL(blob), download: `revamped-image-gen-${Date.now()}.log` });
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
                    },
                }, icon('download'), h('span', {}, 'Export')),
                h('button.iig-btn.small.ghost', { type: 'button', onclick: () => { clearRefCache(); toast.success('Reference cache cleared'); } }, icon('broom'), h('span', {}, 'Clear cache')),
            ),
            logBox,
            h('p.iig-muted.small.iig-credits', {},
                `${DISPLAY_NAME} v${VERSION} · AGPL-3.0-or-later · Based on `,
                h('a', { href: 'https://github.com/aceeenvw/notsosillynotsoimages', target: '_blank', rel: 'noopener' }, 'notsosillynotsoimages'),
                ' by aceeenvw and ',
                h('a', { href: 'https://github.com/0xl0cal/sillyimages', target: '_blank', rel: 'noopener' }, 'SillyImages'),
                ' by 0xl0cal.',
            ),
        ], { iconName: 'stethoscope' });
    }

    function render() {
        if (!visible) return;
        const openState = [...el.querySelectorAll('details.iig-section')].map(d => d.open);
        const styleList = h('datalist', { id: 'iig-style-list' }, settings().styles.map(st => h('option', { value: st.value }, st.name)));
        el.replaceChildren(
            h('div.iig-card', {},
                flag('enabled', 'Image generation on', null, () => { updateInjection(); render(); }),
            ),
            connectionSection(),
            defaultsSection(),
            stylesSection(),
            instructionsSection(),
            videoSection(),
            behaviourSection(),
            deviceSection(),
            maintenanceSection(),
            styleList,
        );
        // Keep sections the user had open across re-renders.
        el.querySelectorAll('details.iig-section').forEach((d, i) => { if (openState[i] !== undefined) d.open = openState[i]; });
    }

    return {
        id: 'settings',
        label: 'Settings',
        icon: 'gear',
        el,
        onShow: () => { visible = true; render(); },
        onHide: () => { visible = false; },
        refresh: render,
    };
}
