// Smoke test: drives the harness in Chromium at phone, tablet and desktop sizes,
// fails on console errors, and saves screenshots to dev/.tmp/shots.
//   node dev/server.mjs &   then   node dev/smoke.mjs
// If playwright is installed globally, point PLAYWRIGHT at it, e.g.
//   PLAYWRIGHT=/opt/node22/lib/node_modules/playwright/index.js node dev/smoke.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const chromium = pw.chromium || pw.default.chromium;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dev', '.tmp', 'shots');
const BASE = process.env.BASE || 'http://localhost:8123';
fs.mkdirSync(OUT, { recursive: true });

const devices = [
    { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    { name: 'tablet', viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
    { name: 'desktop', viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
let failures = 0;
const check = (cond, msg) => {
    if (!cond) { failures++; console.log(`  FAIL ${msg}`); } else console.log(`  ok   ${msg}`);
};

for (const d of devices) {
    console.log(`\n# ${d.name}`);
    const ctx = await browser.newContext({ viewport: d.viewport, isMobile: d.isMobile, hasTouch: d.hasTouch, deviceScaleFactor: d.deviceScaleFactor });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource|^\[RIG\]/.test(m.text())) errors.push(m.text()); });
    const shot = (n) => page.screenshot({ path: path.join(OUT, `${d.name}-${n}.png`) });

    await page.goto(BASE);
    await page.waitForFunction(() => window.harnessReady === true, null, { timeout: 15000 });

    // Placeholders appear for both pending tags.
    await page.waitForSelector('#chat .iig-ph', { timeout: 5000 });
    check(await page.locator('#chat .iig-ph').count() === 2, 'two placeholders while generating');
    await shot('1-generating');

    // Both finish, and the message source is rewritten to real files.
    await page.waitForFunction(() => document.querySelectorAll('#chat img.iig-img').length === 2, null, { timeout: 20000 });
    const mes = await page.evaluate(() => window.harness.chat[1].mes);
    check(!mes.includes('[IMG:GEN]') && (mes.match(/src="\/user\/images\//g) || []).length === 2, 'message source points at saved files');
    check(await page.evaluate(() => window.harness.prompts.revamped_image_gen?.v.includes('data-iig-instruction')), 'instruction injected into prompt');
    await page.evaluate(() => document.querySelector('#chat img.iig-img').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await shot('2-done');

    // A failing tag shows an error card, then the source is marked failed.
    await page.evaluate(() => window.harness.addAiMessage(`Oops <img data-iig-instruction='{"prompt":"this will fail on purpose"}' src="[IMG:GEN]">`));
    await page.waitForSelector('#chat .iig-ph.is-error', { timeout: 15000 });
    check(await page.evaluate(() => window.harness.chat[2].mes.includes('error.svg')), 'failed tag marked in source');
    await page.evaluate(() => document.querySelector('#chat .iig-ph.is-error').scrollIntoView({ block: 'center' }));
    await shot('3-error');

    // Edit & retry from the error card rewrites the prompt and produces an image.
    await page.locator('#chat .iig-ph.is-error [data-act="edit"]').click();
    await page.waitForSelector('.iig-modal.is-open');
    await page.waitForTimeout(250);
    await shot('3b-editor');
    await page.fill('.iig-modal .iig-prompt', 'this one works now');
    await page.locator('.iig-modal .iig-btn.primary').click();
    await page.waitForFunction(() => /this one works now[^]*src="\/user\/images\//.test(window.harness.chat[2].mes), null, { timeout: 15000 });
    check(true, 'edit & retry replaced prompt and image in source');
    check(!(await page.evaluate(() => window.harness.chat[2].mes.includes('error.svg'))), 'error marker gone after retry');

    // Viewer opens on tap and pages between images.
    await page.locator('#chat img.iig-img').first().click();
    await page.waitForSelector('.iig-viewer.is-open');
    await page.waitForTimeout(250);
    check(await page.locator('.iig-viewer-count').innerText() === '1 / 2', 'viewer shows 1 / 2');
    await shot('4-viewer');
    await page.keyboard.press('ArrowRight');
    check(await page.locator('.iig-viewer-count').innerText() === '2 / 2', 'arrow key pages');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Regenerate from the viewer: placeholder replaces the image, then a new file lands.
    const before = await page.evaluate(() => window.harness.chat[1].mes.match(/src="(\/user\/images\/[^"]+)"/)[1]);
    await page.locator('#chat img.iig-img').first().click();
    await page.waitForSelector('.iig-viewer.is-open');
    await page.locator('.iig-viewer-act.primary').click();
    await page.waitForSelector('#chat .iig-ph', { timeout: 5000 });
    await page.waitForFunction((old) => !window.harness.chat[1].mes.includes(old) && document.querySelectorAll('#chat .mes[mesid="1"] img.iig-img').length === 2, before, { timeout: 15000 });
    check(true, 'regenerate swapped in a new file');

    // A failed regenerate (edited prompt that the mock rejects) must keep the existing image.
    const keep = await page.evaluate(() => window.harness.chat[1].mes.match(/src="(\/user\/images\/[^"]+)"/)[1]);
    if (d.name === 'phone') { await page.evaluate(() => window.RevampedImageGen.close()); await page.waitForTimeout(300); }
    await page.evaluate(() => document.querySelector('#chat .mes[mesid="1"] img.iig-img').scrollIntoView({ block: 'center' }));
    await page.locator('#chat .mes[mesid="1"] img.iig-img').first().click();
    await page.waitForSelector('.iig-viewer.is-open');
    await page.locator('.iig-viewer-act', { hasText: 'Edit & redo' }).click();
    await page.waitForSelector('.iig-modal.is-open');
    await page.fill('.iig-modal .iig-prompt', 'please fail this time');
    await page.locator('.iig-modal .iig-btn.primary').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast.error')].some(t => /Regenerate failed/.test(t.textContent)), null, { timeout: 15000 });
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.harness.chat[1].mes);
    check(after.includes(keep) && !after.includes('please fail'), 'failed regenerate keeps the original image and prompt in source');
    check(await page.evaluate((src) => !!document.querySelector(`#chat img.iig-img[src="${src}"]`), keep), 'failed regenerate restores the image in the DOM');
    if (d.name === 'phone') await page.locator('#iig-fab').waitFor({ state: 'visible' });

    // Auto-generate off: pending tags become "Tap to generate" cards.
    await page.evaluate(async () => {
        window.SillyTavern.getContext().extensionSettings.revamped_image_gen.autoGenerate = false;
        await window.harness.addAiMessage(`Manual <img data-iig-instruction='{"prompt":"a manual one"}' src="[IMG:GEN]">`);
    });
    await page.waitForSelector('#chat .iig-ph-idle');
    await page.locator('#chat .iig-ph-idle').click();
    await page.waitForFunction(() => window.harness.chat[3].mes.includes('/user/images/'), null, { timeout: 15000 });
    check(true, 'tap-to-generate works with auto-generate off');
    await page.evaluate(() => { window.SillyTavern.getContext().extensionSettings.revamped_image_gen.autoGenerate = true; });

    // Panel: open from the FAB, visit each tab.
    await page.locator('#iig-fab').click();
    await page.waitForSelector('.iig-panel.is-open');
    await page.waitForTimeout(350);
    const mode = await page.locator('.iig-panel').getAttribute('data-mode');
    check(mode === (d.name === 'phone' ? 'sheet' : 'right'), `panel layout is ${mode}`);
    await page.fill('.iig-prompt', 'Lodi reading by the lamp, cozy, painterly');
    await page.waitForTimeout(250);
    await shot('5-create');
    await page.locator('.iig-go').click();
    await page.waitForFunction(() => document.querySelectorAll('#iig-tab-create .iig-tile img').length >= 1, null, { timeout: 20000 });
    await page.waitForTimeout(200);
    await shot('6-create-result');

    for (const tab of ['queue', 'gallery', 'refs', 'settings']) {
        await page.locator(`.iig-tab[data-tab="${tab}"]`).click();
        await page.waitForTimeout(250);
        await shot(`7-${tab}`);
    }
    await page.locator('.iig-tab[data-tab="gallery"]').click();
    await page.waitForTimeout(200);
    check(await page.locator('#iig-tab-gallery .iig-tile').count() === 5, 'gallery shows 4 chat + 1 studio images');

    // Test connection with the mock provider.
    await page.locator('.iig-tab[data-tab="settings"]').click();
    await page.locator('details.iig-section summary', { hasText: 'Connection' }).click();
    await page.getByRole('button', { name: 'Test' }).click();
    await page.waitForSelector('.toast.success', { timeout: 5000 });
    check(true, 'test connection succeeds');

    if (d.hasTouch) {
        // Real touch input via CDP: swipe pages the viewer, swipe down closes it.
        const cdp = await ctx.newCDPSession(page);
        const swipe = async (x0, y0, x1, y1) => {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
            for (let i = 1; i <= 8; i++) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 8, y: y0 + (y1 - y0) * i / 8 }] });
                await page.waitForTimeout(16);
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await page.waitForTimeout(350);
        };
        await page.keyboard.press('Escape').catch(() => {});
        const vw = d.viewport.width;
        const vh = d.viewport.height;
        // Close the panel first so the chat image is reachable.
        await page.evaluate(() => window.RevampedImageGen.close());
        await page.waitForTimeout(350);
        await page.evaluate(() => document.querySelector('#chat .mes[mesid="1"] img.iig-img').scrollIntoView({ block: 'center' }));
        await page.locator('#chat .mes[mesid="1"] img.iig-img').first().tap();
        await page.waitForSelector('.iig-viewer.is-open');
        await swipe(vw * 0.8, vh / 2, vw * 0.2, vh / 2);
        check(await page.locator('.iig-viewer-count').innerText() === '2 / 2', 'swipe left pages the viewer');
        await swipe(vw / 2, vh * 0.35, vw / 2, vh * 0.75);
        check(await page.locator('.iig-viewer').isHidden(), 'swipe down closes the viewer');
        await page.evaluate(() => window.RevampedImageGen.open('create'));
        await page.waitForTimeout(350);
    }

    if (d.name === 'phone') {
        // Expand sheet to full by tapping the handle, then close by swiping down.
        await page.locator('.iig-grab').click();
        await page.waitForTimeout(350);
        check(await page.locator('.iig-panel').getAttribute('data-snap') === 'full', 'tap handle → full sheet');
        await shot('8-sheet-full');
        const cdp = await ctx.newCDPSession(page);
        const grab = await page.locator('.iig-grab').boundingBox();
        const y0 = grab.y + grab.height / 2;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: y0 }] });
        for (let i = 1; i <= 10; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: y0 + i * 70 }] });
            await page.waitForTimeout(16);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(450);
        check(!(await page.locator('.iig-panel').evaluate(e => e.classList.contains('is-open'))), 'drag sheet down closes it');
    }

    // Results that finish after a chat switch are parked and applied on return.
    await page.evaluate(async () => {
        await window.harness.addAiMessage(`Later <img data-iig-instruction='{"prompt":"a quiet harbour at night"}' src="[IMG:GEN]">`);
        await window.harness.switchChat('Other chat');
    });
    await page.waitForFunction(() => window.SillyTavern.getContext().extensionSettings.revamped_image_gen.pendingFixups.length === 1, null, { timeout: 20000 });
    await page.evaluate(() => window.harness.switchChat('Elodie - 2026-10-23'));
    await page.waitForFunction(() => window.harness.chat[4].mes.includes('/user/images/'), null, { timeout: 5000 });
    check(true, 'parked result applied after returning to the chat');

    check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
