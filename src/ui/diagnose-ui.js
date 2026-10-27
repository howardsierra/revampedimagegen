/*
 * Revamped Image Gen — the Diagnose window. Licensed under AGPL-3.0-or-later.
 */

import { diagnosticsReport, runDiagnostics } from '../diagnose.js';
import { toast } from '../st.js';
import { copyText, h, icon, setChildren } from './dom.js';

const STATUS_ICON = { run: 'spinner fa-spin', ok: 'circle-check', warn: 'circle-exclamation', fail: 'circle-xmark', skip: 'circle-minus' };

export function openDiagnostics({ autoRun = true } = {}) {
    let steps = [];
    let running = false;
    const list = h('div.iig-diag-list', { role: 'list', 'aria-live': 'polite' });
    const summary = h('div.iig-diag-summary');
    const testBox = h('input', { type: 'checkbox' });
    const runBtn = h('button.iig-btn.primary', { type: 'button', onclick: () => run() }, icon('stethoscope'), h('span', {}, 'Run checks'));
    const copyBtn = h('button.iig-btn', {
        type: 'button', disabled: true,
        onclick: async () => { if (await copyText(diagnosticsReport(steps))) toast.success('Report copied (API keys are masked)'); },
    }, icon('copy'), h('span', {}, 'Copy report'));

    function paint() {
        setChildren(list, ...steps.map(st => h(`div.iig-diag-step.is-${st.status}`, { role: 'listitem' },
            h('span.iig-diag-icon', {}, icon(STATUS_ICON[st.status])),
            h('div.iig-diag-main', {},
                h('div.iig-diag-label', {}, st.label),
                st.detail ? h('div.iig-diag-detail', {}, st.detail) : null,
                st.fix ? h('div.iig-diag-fix', {}, icon('lightbulb'), ` ${st.fix}`) : null,
                st.action ? h('button.iig-btn.small.primary', {
                    type: 'button', onclick: async () => { st.action.run(); toast.success('Done — running the checks again'); await run(); },
                }, st.action.label) : null,
            ),
        )));
        const failed = steps.filter(s => s.status === 'fail');
        if (running) setChildren(summary, );
        else if (!steps.length) setChildren(summary, h('p.iig-muted', {}, 'Checks each stage of a generation separately and tells you which one breaks.'));
        else if (failed.length) setChildren(summary, h('div.iig-diag-verdict.bad', {}, icon('circle-xmark'), ` Found ${failed.length} problem${failed.length > 1 ? 's' : ''}. Start with the first one.`));
        else setChildren(summary, h('div.iig-diag-verdict.good', {}, icon('circle-check'), testBox.checked ? ' Everything works, including a real test image.' : ' No problems found. Tick "Include a test image" to try a real generation.'));
    }

    async function run() {
        if (running) return;
        running = true;
        runBtn.disabled = true;
        runBtn.classList.add('is-busy');
        copyBtn.disabled = true;
        steps = [];
        paint();
        try {
            steps = await runDiagnostics({ testImage: testBox.checked, onStep: (s) => { steps = s; paint(); } });
        } finally {
            running = false;
            runBtn.disabled = false;
            runBtn.classList.remove('is-busy');
            copyBtn.disabled = false;
            paint();
        }
    }

    const close = () => {
        modal.classList.remove('is-open');
        setTimeout(() => modal.remove(), 200);
    };
    const modal = h('div.iig-modal', { onclick: (e) => { if (e.target === modal) close(); } },
        h('div.iig-modal-card.iig-diag', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Diagnose' },
            h('div.iig-grab', { 'aria-hidden': 'true' }, h('span')),
            h('header.iig-modal-head', {}, h('h3', {}, 'Diagnose generation'), h('button.iig-icon-btn', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('xmark'))),
            h('div.iig-modal-body', {}, summary, list),
            h('footer.iig-modal-foot.iig-diag-foot', {},
                h('label.iig-inline-check', {}, testBox, h('span', {}, 'Include a test image (uses one generation)')),
                h('div.iig-row', {}, copyBtn, runBtn),
            ),
        ),
    );
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    document.getElementById('iig-root').append(modal);
    requestAnimationFrame(() => modal.classList.add('is-open'));
    paint();
    if (autoRun) run();
}
