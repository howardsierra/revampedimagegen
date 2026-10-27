/*
 * Revamped Image Gen — step-by-step diagnosis of "every generation fails".
 * Each step checks one stage and explains the exact cause and fix.
 * Licensed under AGPL-3.0-or-later.
 */

import { VERSION } from './constants.js';
import { generate, hintFor } from './engine.js';
import { bestModel, modelCaps } from './models.js';
import { listModels, resolveId } from './model-list.js';
import { normalizeBase, getProvider } from './providers.js';
import { save, settings } from './settings.js';
import { IS_IOS, ctx, redact } from './st.js';
import { deleteFile, uploadDataUrl } from './storage.js';

/** A real 8×8 PNG, made on the fly, to check that SillyTavern accepts uploads. */
function tinyPng() {
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = '#e3a14b';
    g.fillRect(0, 0, 8, 8);
    return c.toDataURL('image/png');
}

function originOf(url) {
    try { return new URL(url.replace(/^\/proxy\//, ''), location.href).origin; } catch { return url; }
}

function explainHttp(e, s, provider) {
    const st = e?.status;
    const body = String(e?.body || e?.message || '');
    if (e?.network) {
        return {
            detail: `The browser could not reach ${originOf(normalizeBase(s.endpoint) || provider.defaultEndpoint)}. ${s.useCorsProxy ? 'The CORS proxy is on, so SillyTavern itself could not reach it either (or enableCorsProxy is off in config.yaml).' : 'This is usually CORS: the provider does not allow requests from a web page.'}`,
            fix: s.useCorsProxy
                ? 'Check that config.yaml has enableCorsProxy: true and restart SillyTavern; check the URL.'
                : 'Turn on "Route through ST CORS proxy" (and set enableCorsProxy: true in config.yaml), or check the endpoint URL.',
        };
    }
    if (st === 401 || st === 403 || /api key|unauthor|permission|invalid.*key/i.test(body)) {
        return { detail: `The provider rejected your API key (${st || 'auth error'}).`, fix: 'Paste the key again (no spaces), check it is enabled and has billing/credits, and that it belongs to this provider.' };
    }
    if (st === 404) {
        return { detail: 'The server answered, but the path or model was not found (404).', fix: provider.id === 'openai' ? 'Check the endpoint (base URL only; some aggregators need /v1 or /compatible) and the model id.' : 'Check the endpoint URL and pick a model from the list.' };
    }
    if (st === 429) return { detail: 'Rate limited or out of quota (429).', fix: 'Wait a minute, check your plan/credits, or lower Parallel jobs.' };
    if (st >= 500) return { detail: `The provider had a server error (${st}).`, fix: 'Usually temporary — try again later, or try another model.' };
    return { detail: e?.message || String(e), fix: hintFor(e) || '' };
}

/**
 * Run all checks. `onStep(steps)` is called as each step starts and finishes.
 * @returns {Promise<Array<{id, label, status:'run'|'ok'|'warn'|'fail'|'skip', detail?, fix?, action?}>>}
 */
export async function runDiagnostics({ testImage = false, onStep = () => {} } = {}) {
    const s = settings();
    const provider = getProvider(s.provider);
    const steps = [];
    const step = (id, label) => {
        const st = { id, label, status: 'run' };
        steps.push(st);
        onStep(steps);
        return (patch) => { Object.assign(st, patch); onStep(steps); return st; };
    };
    let blocked = false;

    // 1. Settings
    let done = step('config', 'Settings');
    const problems = [];
    if (!s.enabled) problems.push('Image generation is switched off (Settings, top switch).');
    if (!s.endpoint && !provider.defaultEndpoint) problems.push('No endpoint URL.');
    if (provider.keyRequired && !s.apiKey) problems.push(`${provider.label} needs an API key.`);
    if (/\s/.test(s.apiKey || '')) problems.push('The API key contains spaces or line breaks.');
    if (provider.supportsModels && !s.model) problems.push('No model selected.');
    const caps = modelCaps(s.model);
    if (caps.unsupported) problems.push(caps.unsupported);
    if (s.pathOverride) problems.push(`A path override is set (${s.pathOverride}) — it replaces the normal API path; clear it unless your provider needs it.`);
    if (problems.length) {
        done({ status: 'fail', detail: problems.join(' '), fix: 'Fix these in Settings → Connection.' });
        blocked = !s.enabled || (provider.keyRequired && !s.apiKey);
    } else {
        done({ status: 'ok', detail: `${provider.label} · ${normalizeBase(s.endpoint) || provider.defaultEndpoint} · ${s.model || '(no model)'}` });
    }

    // 2. Reach the provider + key accepted
    let models = null;
    done = step('reach', 'Provider reachable & key accepted');
    if (blocked) done({ status: 'skip', detail: 'Skipped until the settings above are fixed.' });
    else if (!provider.listModels) done({ status: 'skip', detail: `${provider.label} has no model list to test against; the test image below checks the connection.` });
    else {
        models = await listModels({ force: true });
        if (models.error) {
            done({ status: 'fail', ...explainHttp(models.error, s, provider) });
            blocked = true;
        } else done({ status: 'ok', detail: `Connected — ${models.ids.length} models, ${models.images.length} of them image models.` });
    }

    // 3. Model available on this key
    done = step('model', 'Model available on your key');
    if (blocked || !models || models.error) done({ status: 'skip', detail: models ? 'Skipped (see above).' : 'Nothing to compare against.' });
    else if (!s.model) {
        const best = bestModel(models.images);
        done({ status: 'fail', detail: 'No model selected.', fix: best ? `Use ${modelCaps(best).label || best}.` : 'Pick one in Settings → Connection.', action: best ? { label: `Use ${best}`, run: () => { settings().model = best; save('model'); } } : null });
    } else if (models.ids.includes(s.model)) done({ status: 'ok', detail: `${caps.label || s.model} (${s.model}) is available.` });
    else {
        const near = resolveId(s.model, models.ids);
        const best = bestModel(models.images);
        const pick = near || best;
        done({
            status: 'fail',
            detail: `"${s.model}" is not in your account's model list, so every request will fail.${near ? ` Your key has "${near}".` : ''}`,
            fix: pick ? `Switch to ${pick}.` : 'Pick a model from the list in Settings → Connection.',
            action: pick ? { label: `Use ${pick}`, run: () => { settings().model = pick; save('model'); } } : null,
        });
    }

    // 4. SillyTavern accepts the saved image
    done = step('save', 'Saving images to SillyTavern');
    try {
        const path = await uploadDataUrl(tinyPng(), { folder: 'iig_diag', name: `diag_${Date.now()}` });
        await deleteFile(path);
        done({ status: 'ok', detail: 'Upload and delete work.' });
    } catch (e) {
        done({ status: 'fail', detail: e.message, fix: /403/.test(e.message) ? 'SillyTavern refused the upload (session/CSRF). Reload the page and try again.' : 'Check the SillyTavern server console for the error.' });
    }

    // 5. A real (small) test image
    done = step('test', 'Test image');
    if (!testImage) done({ status: 'skip', detail: 'Not run (it uses one generation of credit). Tick "Include a test image" to run it.' });
    else if (blocked) done({ status: 'skip', detail: 'Skipped until the problems above are fixed.' });
    else {
        const t0 = Date.now();
        try {
            const res = await generate('image', { prompt: 'a single red apple on a plain white table, soft light, simple product photo', aspect_ratio: '1:1', image_size: 'auto', no_refs: true }, { fromStudio: true });
            await deleteFile(res.path);
            done({ status: 'ok', detail: `Generated in ${((Date.now() - t0) / 1000).toFixed(1)}s and saved. Generation works — if chat images still fail, the problem is in the prompt or references (check the error on the failed image).` });
        } catch (e) {
            done({ status: 'fail', ...explainHttp(e, s, provider), raw: e.message });
        }
    }
    return steps;
}

/** Plain-text report for sharing. Secrets are masked. */
export function diagnosticsReport(steps) {
    const s = settings();
    const c = ctx();
    const icon = { ok: '✓', warn: '!', fail: '✗', skip: '–', run: '…' };
    const lines = [
        `Revamped Image Gen ${VERSION} diagnostics — ${new Date().toISOString()}`,
        `Provider: ${getProvider(s.provider).label} | endpoint: ${normalizeBase(s.endpoint) || '(default)'} | model: ${s.model || '(none)'} | size: ${s.imageSize}`,
        `CORS proxy: ${s.useCorsProxy ? 'on' : 'off'} | refs: ${s.sendRefs ? 'on' : 'off'} | transport: ${IS_IOS ? 'iOS XHR' : 'fetch'} | ST chat: ${c.getCurrentChatId?.() ? 'open' : 'none'}`,
        `Browser: ${navigator.userAgent}`,
        '',
        ...steps.map(st => `${icon[st.status]} ${st.label}: ${st.detail || ''}${st.fix ? `\n    Fix: ${st.fix}` : ''}${st.raw ? `\n    Raw: ${st.raw}` : ''}`),
    ];
    return redact(lines.join('\n'));
}
