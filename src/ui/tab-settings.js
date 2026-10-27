/*
 * Revamped Image Gen — Settings tab. Licensed under AGPL-3.0-or-later.
 */

import { ASPECT_RATIOS, DEFAULT_INJECT_TEMPLATE, DEFAULT_STYLES, DISPLAY_NAME, VERSION, VIDEO_RESOLUTIONS } from '../constants.js';
import { applyCapture, compileRule } from '../capture.js';
import { RECIPES, modelCaps } from '../models.js';
import { autoProvider, ensureValidModel, forgetModels } from '../model-list.js';
import { modelButton } from './model-picker.js';
import { openDiagnostics } from './diagnose-ui.js';
import { PROVIDERS, getProvider, normalizeNaisteraModel } from '../providers.js';
import { renderInjection, updateInjection } from '../prompt.js';
import { clearRefCache } from '../refs.js';
import { applyProfile, characterExamples, characterKey, importLegacy, legacySettings, onSettingsChange, save, settings, snapshotProfile, updateActiveProfile } from '../settings.js';
import { getCharName, logsAsText, onLog, toast, uid } from '../st.js';
import { chipSelect, copyText, debounce, field, h, icon, section, setChildren, toggle } from './dom.js';
import { confirmDialog } from './editor.js';
import { ratioChip, sizeChips } from './widgets.js';

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

        const key = text('apiKey', {
            type: 'password', placeholder: provider.keyRequired ? 'Required' : 'Optional',
            // A new key may see different models: re-check, and auto-fix an unavailable model.
            onAfter: debounce(() => { forgetModels(); ensureValidModel().then(() => paintCaps()); }, 900),
        });
        const eye = h('button.iig-icon-btn', {
            type: 'button', 'aria-label': 'Show key', onclick: () => {
                key.type = key.type === 'password' ? 'text' : 'password';
                eye.replaceChildren(icon(key.type === 'password' ? 'eye' : 'eye-slash'));
            },
        }, icon('eye'));

        const capsLine = h('div.iig-caps');
        const paintCaps = () => {
            const m = settings().model;
            const c = modelCaps(m);
            capsLine.hidden = !m;
            if (!m) return;
            const bits = [`sizes ${c.sizes.filter(x => x !== '512').join('/')} (auto ${c.defaultSize})`];
            bits.push(c.hardRefs ? `refs: ${c.maxRefs} by default, up to ${c.hardRefs}` : 'no reference images');
            setChildren(capsLine, ...[h('span', {}, bits.join(' · ')), (c.unsupported || c.note) ? h('small', {}, c.unsupported || c.note) : null].filter(Boolean));
            capsLine.classList.toggle('is-warn', !!c.unsupported);
        };
        const modelBtn = modelButton();
        paintCaps();

        const providerExtras = [];
        if (provider.id === 'naistera') {
            const nm = h('select.iig-input', {
                onchange: () => { settings().naisteraModel = nm.value; save('naisteraModel'); },
            }, provider.models.map(m => h('option', { value: m }, m.replace(/\b\w/g, c => c.toUpperCase()))));
            nm.value = normalizeNaisteraModel(s.naisteraModel);
            providerExtras.push(field('Naistera model', nm), field('Preset (Grok only)', select('naisteraPreset', [{ value: '', label: 'None' }, { value: 'digital', label: 'Digital' }, { value: 'realism', label: 'Realism' }])));
        }
        if (provider.id === 'openai') {
            providerExtras.push(
                flag('openaiFidelity', 'High input fidelity', 'gpt-image-1 / 1.5: keep faces closer to reference photos (costs more input tokens)'),
                h('div.iig-row-2', {},
                    field('Moderation', select('openaiModeration', [{ value: 'auto', label: 'Auto' }, { value: 'low', label: 'Low (less strict)' }])),
                    field('Output format', select('openaiFormat', [{ value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP (smaller)' }, { value: 'jpeg', label: 'JPEG (smallest)' }])),
                ),
            );
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
                    const list = (await p.listModels(settings())).map(m => (m && typeof m === 'object' ? m.id : m));
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

        const recipes = h('div.iig-recipes', {}, RECIPES.map(r => h(`button.iig-recipe${s.provider === r.provider && (!r.models.length || r.models.includes(s.model)) ? '.active' : ''}`, {
            type: 'button',
            onclick: () => {
                const st = settings();
                if (st.provider !== r.provider) st.apiKey = '';
                st.provider = r.provider;
                st.endpoint = r.endpoint;
                st.pathOverride = '';
                st.useCorsProxy = false;
                if (r.models.length) st.model = r.models[0];
                else if (st.provider !== r.provider) st.model = '';
                save('provider');
                render();
                toast.info(r.keyHint, { timeOut: 6000 });
                forgetModels();
                if (st.apiKey) ensureValidModel();
                setTimeout(() => el.querySelector('input[type="password"]')?.focus(), 50);
            },
        }, icon(r.icon), h('span.iig-recipe-title', {}, r.title), h('small', {}, r.subtitle))));

        return section('Connection', [
            field('Quick setup', recipes, 'Tuned presets for Nano Banana and GPT Image. Pick one, paste your key, done.'),
            field('Profile', h('div.iig-stack', {}, profileSel, profileRow), 'Save complete provider setups and switch with one tap.'),
            field('API type', providerSel, provider.hint),
            field('Endpoint URL', text('endpoint', { type: 'url', placeholder: provider.defaultEndpoint || 'https://…', inputmode: 'url', onAfter: () => { forgetModels(); if (autoProvider()) render(); } }), 'Base URL, as your provider documents it (with or without /v1).'),
            field('API key', h('div.iig-input-group', {}, key, eye), 'Stored in SillyTavern\'s settings.json and masked in logs.'),
            provider.supportsModels || provider.id !== 'naistera'
                ? field('Model', h('div.iig-stack', {}, modelBtn.el, capsLine), 'Tap to see the models your key can use, with what each one supports.')
                : null,
            ...providerExtras,
            provider.supportsRefs ? flag('sendRefs', 'Send reference images', 'Turn off for providers that reject image input') : null,
            flag('useCorsProxy', 'Route through ST CORS proxy', 'For providers that block browser requests. Needs enableCorsProxy: true in config.yaml.'),
            h('details.iig-more', {}, h('summary', {}, 'Advanced'),
                field('Path override', text('pathOverride', { placeholder: 'e.g. /api/v2/images or /v1beta/models/{model}:generateContent' }), 'Replaces the auto-appended path. Leave empty normally.'),
                field('Request timeout (seconds)', text('timeoutSec', { type: 'number', min: 30, max: 1800 })),
            ),
            h('div.iig-row.wrap', {}, testBtn, h('button.iig-btn.small', { type: 'button', title: 'Check every stage of a generation', onclick: () => openDiagnostics() }, icon('stethoscope'), h('span', {}, 'Diagnose'))),
        ], { open: !s.apiKey && provider.keyRequired, iconName: 'plug' });
    }

    // ------------------------------------------------------------ defaults & styles

    function defaultsSection() {
        const s = settings();
        const ar = chipSelect(ASPECT_RATIOS, s.aspectRatio, (v) => { settings().aspectRatio = v; save('aspectRatio'); }, { className: 'iig-chips-scroll', render: ratioChip });
        const size = sizeChips(s.imageSize || 'auto', (v) => { settings().imageSize = v; save('imageSize'); });
        return section('Image defaults', [
            flag('tagOverrides', 'Let the AI\'s tag choose style & size', 'Off: your defaults below always win (aspect ratio still follows the tag)'),
            field('Default style', text('defaultStyle', { placeholder: 'e.g. semi-realistic digital painting', list: 'iig-style-list' })),
            field('Aspect ratio (when the tag has none)', ar.el),
            field('Resolution', size.el, 'Auto picks each model\'s own best size; a fixed size is clamped to what the model supports.'),
            field('Quality (GPT Image)', select('quality', (modelCaps(s.model).qualities.length ? modelCaps(s.model).qualities : ['auto', 'low', 'medium', 'high']).map(q => ({ value: q, label: q })))),
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
            field('Template', tpl, '{{iig_names}} → names with reference photos, {{iig_max}} → the limit above, {{iig_examples}} → your example prompts. ST macros like {{char}} work too.'),
            h('div.iig-row.wrap', {},
                h('button.iig-btn.small', { type: 'button', onclick: () => { preview.hidden = !preview.hidden; refreshPreview(); } }, icon('eye'), h('span', {}, 'Preview')),
                h('button.iig-btn.small.ghost', { type: 'button', onclick: () => { settings().injectTemplate = DEFAULT_INJECT_TEMPLATE; tpl.value = DEFAULT_INJECT_TEMPLATE; save('injectTemplate'); refreshPreview(); } }, icon('rotate-left'), h('span', {}, 'Reset')),
            ),
            preview,
            field('Tell the AI to write', (() => {
                const st = settings();
                const sel = h('select.iig-input', {
                    onchange: () => {
                        st.injectFormat = sel.value;
                        // The chosen format must be captured, or nothing would generate.
                        const rule = st.captureRules.find(r => r.id === sel.value);
                        if (rule && !rule.enabled) { rule.enabled = true; toast.info(`Turned on capture rule "${rule.name}"`); }
                        save('injectFormat');
                        refreshPreview();
                        render();
                    },
                }, h('option', { value: 'html' }, 'HTML image tag (most control)'),
                st.captureRules.map(r => h('option', { value: r.id }, `${r.name}${r.builtin ? ' (simpler)' : ''}`)));
                sel.value = st.injectFormat || 'html';
                return sel;
            })(), 'Simple formats are more reliable with smaller models and use fewer tokens. They are converted by Prompt capture below.'),
            flag('compactHistory', 'Shorten old image tags in the prompt', 'Replaces finished tags with a one-line note. Saves tokens; stops the model copying file paths.'),
        ], { iconName: 'robot' });
    }

    // ------------------------------------------------------------ example prompts

    function examplesSection() {
        let scope = characterExamples()?.length ? 'character' : 'global';
        const listEl = h('div.iig-examples');
        const scopeHint = h('p.iig-muted.small');
        const listFor = (create = false) => (scope === 'character' ? characterExamples({ create }) : settings().promptExamples);
        const changed = () => save(scope === 'character' ? 'charExamples' : 'promptExamples');

        function draw() {
            const hasChar = !!characterKey();
            if (scope === 'character' && !hasChar) scope = 'global';
            scopeChips.set(scope);
            scopeChips.el.querySelector('[data-value="character"]').disabled = !hasChar;
            const list = listFor() || [];
            scopeHint.textContent = scope === 'character'
                ? `Only for ${getCharName() || 'this character'}. When this list has examples, it replaces the "Every chat" list for this card.`
                : (characterExamples()?.some(x => x.enabled !== false) ? 'Used in every chat — except this character, which has its own list.' : 'Used in every chat unless a character has its own list.');
            setChildren(listEl, list.length ? list.map((ex, i) => {
                const fit = () => { t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 2}px`; };
                const save1 = debounce(() => { ex.text = t.value; changed(); }, 300);
                const t = h('textarea.iig-input', { rows: 3, value: ex.text, 'aria-label': `Example ${i + 1}`, oninput: () => { fit(); save1(); } });
                requestAnimationFrame(fit);
                const on = h('input', { type: 'checkbox', checked: ex.enabled !== false, 'aria-label': 'Use this example', onchange: () => { ex.enabled = on.checked; changed(); } });
                return h('div.iig-example-row', {}, h('label.iig-example-on', { title: 'Use this example' }, on), t,
                    h('button.iig-icon-btn', { type: 'button', 'aria-label': 'Delete example', onclick: () => { list.splice(i, 1); changed(); draw(); } }, icon('trash')));
            }) : h('div.iig-empty.small', {}, h('p', {}, 'No examples yet. Tap "Add example" and paste a prompt written the way you like. A prompt that already gave you a great image is the best example.')));
        }

        const scopeChips = chipSelect([
            { value: 'global', label: 'Every chat' },
            { value: 'character', label: 'This character' },
        ], scope, (v) => { scope = v; draw(); });

        draw();
        const sec = section('Example prompts', [
            h('p.iig-muted.small', {}, 'Show the chat model what a good image prompt looks like for your story — the look, the structure, the detail. It writes new prompts for what is happening in the roleplay in the same style. Used for image tags in replies, Illustrate and Auto-illustrate.'),
            scopeChips.el,
            scopeHint,
            listEl,
            h('div.iig-row.wrap', {},
                h('button.iig-btn.small.iig-add-example', { type: 'button', onclick: () => { const l = listFor(true); if (!l) return; l.push({ id: uid('ex'), text: '', enabled: true }); changed(); draw(); listEl.querySelector('.iig-example-row:last-child textarea')?.focus(); } }, icon('plus'), h('span', {}, 'Add example')),
            ),
            h('p.iig-muted.small', {}, 'Tip: in the image viewer, tap ⓘ → "Save as example" to add the prompt of any image you liked. Two or three varied examples work best; write them with your own characters\' names.'),
            h('div.iig-row-2', {},
                field('Examples sent', text('examplesMax', { type: 'number', min: 0, max: 8 }), 'Per request; more costs more tokens.'),
                field('Context messages', text('sceneContext', { type: 'number', min: 0, max: 12 }), 'Earlier messages read when the extension writes a prompt itself.'),
            ),
        ], { iconName: 'feather' });
        // Boxes measured while the section was closed have no height yet.
        sec.addEventListener('toggle', () => { if (sec.open) for (const t of listEl.querySelectorAll('textarea')) { t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 2}px`; } });
        return sec;
    }

    // ------------------------------------------------------------ prompt capture (regex)

    function captureSection() {
        const st = settings();
        const sample = h('textarea.iig-input', { rows: 4, placeholder: 'Paste a sample AI reply to test the enabled rules…', oninput: debounce(() => runTest(), 200) });
        const out = h('div.iig-stack.iig-capture-out');
        const runTest = () => {
            if (!sample.value.trim()) { setChildren(out, ); return; }
            const { captured, errors } = applyCapture(sample.value, st.captureRules);
            setChildren(out, 
                ...errors.map(e => h('div.iig-capture-err', {}, icon('triangle-exclamation'), ` ${e.rule}: ${e.error}`)),
                ...(captured.length
                    ? captured.map(c => h('div.iig-capture-hit', {}, h('small.iig-muted', {}, c.rule), h('div', {}, c.data.prompt),
                        h('small.iig-muted', {}, Object.entries(c.data).filter(([k]) => k !== 'prompt').map(([k, v]) => `${k}: ${v}`).join(' · '))))
                    : [h('small.iig-muted', {}, 'No prompts captured.')]),
            );
        };
        const list = h('div.iig-stack');
        const draw = () => {
            list.replaceChildren(...st.captureRules.map((r, i) => {
                const err = compileRule(r).error;
                const pattern = h('input.iig-input.mono', {
                    type: 'text', value: r.pattern, readOnly: !!r.builtin, 'aria-label': 'Pattern', spellcheck: 'false',
                    oninput: debounce(() => { r.pattern = pattern.value; save('captureRules'); draw(); runTest(); }, 400),
                });
                return h(`div.iig-rule${r.enabled ? '.on' : ''}`, {},
                    h('div.iig-row.between', {},
                        r.builtin
                            ? h('strong', {}, r.name)
                            : h('input.iig-input.narrow-wide', { type: 'text', value: r.name, 'aria-label': 'Rule name', oninput: debounce((e) => { r.name = e.target.value; save('captureRules'); }, 300) }),
                        toggle('', r.enabled, (v) => { r.enabled = v; save('captureRules'); runTest(); }),
                    ),
                    r.builtin ? h('code.iig-pattern', {}, r.pattern) : pattern,
                    r.builtin ? null : h('input.iig-input', { type: 'text', value: r.example || '', placeholder: 'What the AI should write, e.g. [[draw: PROMPT]]', 'aria-label': 'Example for the AI', oninput: debounce((e) => { r.example = e.target.value; save('captureRules'); updateInjection(); }, 300) }),
                    err ? h('small.iig-capture-err', {}, err) : null,
                    r.builtin ? null : h('div.iig-row.wrap', {},
                        h('input.iig-input.narrow', { type: 'text', value: r.flags || 'gi', 'aria-label': 'Flags', title: 'Regex flags', oninput: debounce((e) => { r.flags = e.target.value; save('captureRules'); draw(); runTest(); }, 300) }),
                        h('select.iig-input.narrow', { 'aria-label': 'Kind', onchange: (e) => { r.kind = e.target.value; save('captureRules'); } },
                            h('option', { value: 'image', selected: r.kind !== 'video' }, 'Image'), h('option', { value: 'video', selected: r.kind === 'video' }, 'Video')),
                        toggle('Keep text', !!r.keepText, (v) => { r.keepText = v; save('captureRules'); }),
                        h('button.iig-icon-btn', { type: 'button', 'aria-label': 'Delete rule', onclick: () => { st.captureRules.splice(i, 1); if (st.injectFormat === r.id) st.injectFormat = 'html'; save('captureRules'); draw(); } }, icon('trash')),
                    ),
                );
            }));
        };
        draw();
        return section('Prompt capture (regex)', [
            h('p.iig-muted.small', {}, 'Turn image requests in any format into images. Use a named group (?<prompt>…) or the first group for the prompt; optional groups (?<style>), (?<ar>), (?<size>), (?<neg>). Flags in the prompt like --ar 16:9, --style …, --no … are understood.'),
            list,
            h('div.iig-row.wrap', {},
                h('button.iig-btn.small', {
                    type: 'button', onclick: () => {
                        st.captureRules.push({ id: uid('rule'), name: 'My rule', pattern: String.raw`\[\[draw:\s*(?<prompt>[^\]]+)\]\]`, flags: 'gi', enabled: true, kind: 'image', keepText: false, example: '[[draw: PROMPT]]' });
                        save('captureRules');
                        draw();
                    },
                }, icon('plus'), h('span', {}, 'Add rule')),
            ),
            field('Test', sample),
            out,
        ], { iconName: 'code' });
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
            flag('earlyStart', 'Start images while the reply streams', 'Each image starts as soon as its tag is written, instead of after the whole reply'),
            flag('processUserMessages', 'Process image tags in my messages', 'Image tags and capture-rule matches (e.g. a Clover <ooc> order) in your own messages are generated too'),
            field('Auto-illustrate', select('autoIllustrate', [
                { value: '0', label: 'Off' },
                { value: '1', label: 'Every reply without an image' },
                { value: '2', label: 'Every 2nd reply without an image' },
                { value: '3', label: 'Every 3rd reply without an image' },
                { value: '5', label: 'Every 5th reply without an image' },
            ]), 'When the chat model did not ask for an image, the extension writes a prompt for the scene itself (one extra background request) and generates it.'),
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
        setChildren(el, 
            h('div.iig-card.iig-card-slim', {},
                flag('enabled', 'Image generation on', null, () => { updateInjection(); render(); }),
            ),
            connectionSection(),
            defaultsSection(),
            stylesSection(),
            instructionsSection(),
            examplesSection(),
            captureSection(),
            videoSection(),
            behaviourSection(),
            deviceSection(),
            maintenanceSection(),
            styleList,
        );
        // Keep sections the user had open across re-renders.
        el.querySelectorAll('details.iig-section').forEach((d, i) => { if (openState[i] !== undefined) d.open = openState[i]; });
    }

    onSettingsChange((key) => { if (key === 'model' && visible) render(); });

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
