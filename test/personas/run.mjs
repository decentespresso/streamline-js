// Persona replay harness. Drives the real skin in a real Chromium against a
// real Decaid, so it is a debugging tool, not a pass/fail suite: every step is
// soft — a missing element is recorded and the persona carries on, because the
// interesting output is the console errors, failed requests, screenshots and
// trace that come out the other side.
//
// ponytail: plain `playwright` + one script, no @playwright/test runner. There
// are no assertions to organise, and traces open fine with `npx playwright
// show-trace`. Add the runner if these ever become CI gates.
//
//   node test/personas/run.mjs                       # all personas
//   node test/personas/run.mjs quinn dana            # pick some
//   node test/personas/run.mjs --headed --slow=250
//   node test/personas/run.mjs --base=http://localhost:8044 --decaid=http://localhost:8080
//
// Steps are named in personas.json and resolved from STEPS below.

import { chromium } from 'playwright';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const has = name => args.includes(`--${name}`);
const wanted = args.filter(a => !a.startsWith('--'));

const config = JSON.parse(await readFile(join(HERE, 'personas.json'), 'utf8'));
const BASE = flag('base', config.baseUrl);
const DECAID = flag('decaid', config.decaid);
const SHOT_SECONDS = Number(flag('shot-seconds', 8));

// ---------------------------------------------------------------- step helpers

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Machine-side command. MockBengle reports GHC:true, so the skin hides its
// on-screen GHC column: a persona starts a shot the way a real user does, by
// pressing the machine, which from here is a PUT on Decaid.
async function machineState(ctx, state) {
    const res = await fetch(`${DECAID}/api/v1/machine/state/${state}`, { method: 'PUT' });
    const body = await res.text();
    ctx.note(`PUT machine/state/${state} -> ${res.status} ${body.slice(0, 160)}`);
    if (!res.ok) throw new Error(`machine/state/${state} refused: ${res.status} ${body.slice(0, 160)}`);
}

// Soft tap: wait for the element, click it, record what happened. Returns false
// when it never showed up, so a step can branch instead of dying.
async function tap(ctx, selector, { timeout = 4000, label = selector, quiet = false } = {}) {
    try {
        const el = ctx.page.locator(selector).first();
        await el.waitFor({ state: 'visible', timeout });
        await el.click({ timeout });
        ctx.note(`tapped ${label}`);
        await ctx.page.waitForTimeout(400);
        return true;
    } catch (e) {
        // quiet: the caller has a fallback, so a miss here is not a finding.
        if (!quiet) ctx.note(`MISS ${label}: ${String(e.message).split('\n')[0]}`);
        return false;
    }
}

// The DYE overlay is a plugin iframe and ignores Escape; a real user leaves it
// with CANCEL. Search every frame, because which frame owns the button depends
// on how the plugin is served.
async function closeOverlay(ctx) {
    for (const frame of ctx.page.frames()) {
        for (const label of ['CANCEL', 'Cancel', 'Close', 'Back']) {
            const btn = frame.locator(`button:has-text("${label}")`).first();
            try {
                await btn.waitFor({ state: 'visible', timeout: 1200 });
                await btn.click({ timeout: 2000 });
                ctx.note(`closed overlay via ${label}`);
                await ctx.page.waitForTimeout(2000);
                return true;
            } catch (e) { /* try the next label / frame */ }
        }
    }
    await ctx.page.keyboard.press('Escape');
    ctx.note('MISS overlay close button; pressed Escape');
    await ctx.page.waitForTimeout(1500);
    return false;
}

const STEPS = {
    async boot(ctx) {
        await ctx.page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
        // window.app is published at the end of app.js module evaluation.
        await ctx.page.waitForFunction(() => window.app && window.app.api, null, { timeout: 20000 });
        await ctx.page.waitForTimeout(2500); // sockets, history, profiles settle
    },

    async wake(ctx) {
        const snap = await (await fetch(`${DECAID}/api/v1/machine/state`)).json();
        ctx.note(`machine was ${snap?.state?.state}/${snap?.state?.substate}`);
        if (snap?.state?.state === 'sleeping') {
            // A real user taps the sleep screen; if that does not take, press
            // the machine (PUT) so the rest of the persona still runs.
            await ctx.page.mouse.click(ctx.persona.viewport.width / 2, ctx.persona.viewport.height / 2);
            await ctx.page.waitForTimeout(2000);
            const again = await (await fetch(`${DECAID}/api/v1/machine/state`)).json();
            if (again?.state?.state === 'sleeping') await machineState(ctx, 'idle');
            else ctx.note('woke by tapping the sleep screen');
        }
        await ctx.page.waitForTimeout(1500);
    },

    async sleep(ctx) {
        await machineState(ctx, 'sleeping');
        await ctx.page.waitForTimeout(1500);
    },

    async startShot(ctx) {
        // blockOnNoScale can refuse espresso when no scale is connected; the
        // note records the refusal body instead of hiding it.
        await machineState(ctx, 'espresso');
        await ctx.page.waitForTimeout(1200);
    },

    async stopShot(ctx) {
        await machineState(ctx, 'idle');
        await ctx.page.waitForTimeout(3000); // shot save + history repaint
    },

    async pullShot(ctx) {
        await STEPS.startShot(ctx);
        await ctx.page.waitForTimeout(SHOT_SECONDS * 1000);
        await STEPS.stopShot(ctx);
    },

    // With DYE2 on, the header shows the DYE strip instead of #profile-fav-nav,
    // so fall through to whatever the strip is currently rendering.
    async favTap(ctx) {
        if (!await tap(ctx, '#fav-profile-btn-0', { timeout: 2500, quiet: true, label: 'favourite profile 1' })) {
            await tap(ctx, '#dye-strip button', { timeout: 2500, label: 'first DYE strip item' });
        }
        await ctx.page.waitForTimeout(1200);
    },

    async grindBump(ctx) {
        for (let i = 0; i < 3; i++) await tap(ctx, '#grind-plus', { label: 'grind +' });
        await tap(ctx, '#grind-minus', { label: 'grind -' });
        await tap(ctx, '#steam-preset-2', { label: 'steam 30s preset' });
        await tap(ctx, '#flush-preset-1', { label: 'flush 10s preset' });
    },

    async dyeStripModes(ctx) {
        for (const mode of ['P', 'F', 'R']) {
            await tap(ctx, `#dye-toggle-${mode}`, { label: `strip mode ${mode}` });
            await ctx.page.waitForTimeout(600);
        }
    },

    async openDye(ctx) {
        if (!await tap(ctx, '#dye-open-btn', { label: 'DYE overlay' })) return;
        await ctx.page.waitForTimeout(4000);
        await closeOverlay(ctx);
    },

    async openHistory(ctx) {
        await tap(ctx, '#history-prev-btn', { label: 'history prev' });
        await ctx.page.waitForTimeout(1200);
    },

    async historyBrowse(ctx) {
        for (let i = 0; i < 4; i++) {
            await tap(ctx, '#history-prev-btn', { label: `history prev ${i + 1}` });
        }
        for (let i = 0; i < 2; i++) {
            await tap(ctx, '#history-next-btn', { label: `history next ${i + 1}` });
        }
    },

    async chartZoom(ctx) {
        const chart = ctx.page.locator('#chart-wrap').first();
        try {
            await chart.waitFor({ state: 'visible', timeout: 4000 });
            const box = await chart.boundingBox();
            await ctx.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await ctx.page.waitForTimeout(2000);
            await ctx.page.keyboard.press('Escape');
            ctx.note('chart tapped (expanded view)');
        } catch (e) {
            ctx.note(`MISS chart: ${String(e.message).split('\n')[0]}`);
        }
        await ctx.page.waitForTimeout(1200);
    },

    async openProfiles(ctx) {
        await tap(ctx, '#profile-select-btn', { label: 'profile selector' });
        await ctx.page.waitForTimeout(2000);
    },

    // Preview two profiles in the selector, then leave via Cancel. Confirming
    // would rewrite the owner's active workflow on Decaid, which a debug run
    // has no business doing.
    async pickProfile(ctx) {
        for (const n of [1, 2]) {
            const item = ctx.page.locator('#profile-list [data-profile-key]').nth(n);
            try {
                await item.waitFor({ state: 'visible', timeout: 5000 });
                await item.click();
                ctx.note(`previewed profile ${n} in the selector`);
                await ctx.page.waitForTimeout(1500);
            } catch (e) {
                ctx.note(`MISS profile list item ${n}: ${String(e.message).split('\n')[0]}`);
            }
        }
        await tap(ctx, '#cancel-profile-btn', { label: 'cancel profile selector' });
        await ctx.page.waitForTimeout(1500);
    },

    // Opens the active profile, flips a tab, then closes without saving.
    async openProfileEditor(ctx) {
        if (!await tap(ctx, '#profile-edit-btn', { label: 'profile editor' })) return;
        await ctx.page.waitForSelector('#editor-close-btn', { state: 'visible', timeout: 15000 })
            .then(() => ctx.note('profile editor mounted'))
            .catch(e => ctx.note(`MISS editor mount: ${String(e.message).split('\n')[0]}`));
        await tap(ctx, '#editor-page-next-btn', { timeout: 2500, label: 'editor next page' });
        await tap(ctx, '#editor-close-btn', { label: 'close editor' });
        await ctx.page.waitForTimeout(2000);
    },

    async openSettings(ctx) {
        await tap(ctx, '#settings-btn', { label: 'settings' });
        // The router fetches and injects settings.html; wait for the nav to
        // exist rather than guessing at a fixed delay.
        await ctx.page.waitForSelector('#main-categories-panel .settings-nav-btn', { state: 'visible', timeout: 15000 })
            .then(() => ctx.note('settings page mounted'))
            .catch(e => ctx.note(`MISS settings mount: ${String(e.message).split('\n')[0]}`));
        await ctx.page.waitForTimeout(800);
    },

    // Categories are read off the live nav, never copied from settings-tree.js.
    async walkSettings(ctx) {
        const ids = await ctx.page.$$eval(
            '#main-categories-panel .settings-nav-btn',
            els => els.map(e => e.id).filter(Boolean)
        ).catch(() => []);
        ctx.note(`categories found: ${ids.join(', ') || 'none'}`);
        for (const id of ids) {
            await tap(ctx, `#${id}`, { label: `category ${id}` });
            await ctx.page.waitForTimeout(900);
            await ctx.shot(`category-${id}`);
        }
    },

    async searchSettings(ctx) {
        try {
            await ctx.page.fill('#settings-search', 'temp', { timeout: 4000 });
            await ctx.page.waitForTimeout(1200);
            ctx.note('searched settings for "temp"');
        } catch (e) {
            ctx.note(`MISS settings search: ${String(e.message).split('\n')[0]}`);
        }
    },

    // Cancel, never save: a persona run must not rewrite the owner's machine config.
    async cancelSettings(ctx) {
        if (!await tap(ctx, '#cancel-settings-btn', { label: 'cancel settings' })) {
            await STEPS.backToMain(ctx);
        }
        await ctx.page.waitForTimeout(1500);
    },

    // goBack can land on about:blank when the app is the only history entry,
    // so fall back to a direct navigation rather than leaving a blank page
    // that makes every later step look broken.
    async backToMain(ctx) {
        await ctx.page.goBack().catch(() => {});
        await ctx.page.waitForTimeout(1200);
        // "On the main page" means the main page is actually visible: window.app
        // is alive on every subpage too, and a stray back can land in the
        // selector instead of home.
        const home = await ctx.page.evaluate(() => {
            const main = document.getElementById('main-page');
            const host = document.getElementById('subpage-host');
            return !!(window.app && window.app.api)
                && !!main && getComputedStyle(main).display !== 'none'
                && (!host || host.children.length === 0);
        }).catch(() => false);
        if (!home) {
            ctx.note('back did not land on the main page; navigating to index');
            await ctx.page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
            await ctx.page.waitForFunction(() => window.app && window.app.api, null, { timeout: 20000 });
        }
        await ctx.page.waitForTimeout(1500);
    },

    // Direct subpage launch: a different boot order than clicking into it.
    async deepLinkSettings(ctx) {
        await ctx.page.goto(`${BASE}/index.html?page=settings`, { waitUntil: 'domcontentloaded' });
        await ctx.page.waitForFunction(() => window.app && window.app.api, null, { timeout: 20000 });
        await ctx.page.waitForTimeout(3000);
    },

    async offlineBlip(ctx) {
        await ctx.context.setOffline(true);
        ctx.note('network offline');
        await ctx.page.waitForTimeout(6000);
        await ctx.context.setOffline(false);
        ctx.note('network back');
        await ctx.page.waitForTimeout(6000); // reconnect backoff
    },

    async reload(ctx) {
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        await ctx.page.waitForFunction(() => window.app && window.app.api, null, { timeout: 20000 });
        await ctx.page.waitForTimeout(2500);
    },
};

// ------------------------------------------------------------------ the runner

async function runPersona(browser, persona) {
    const dir = join(OUT, persona.id);
    await mkdir(dir, { recursive: true });

    const context = await browser.newContext({
        viewport: persona.viewport,
        deviceScaleFactor: persona.deviceScaleFactor ?? 1,
        locale: persona.locale ?? 'en-US',
        hasTouch: true,
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    // Seeded before any app script runs, so settingsSync/boot reads see them.
    if (persona.storage && Object.keys(persona.storage).length) {
        await context.addInitScript(entries => {
            for (const [k, v] of Object.entries(entries)) {
                try { localStorage.setItem(k, v); } catch (e) { /* private mode */ }
            }
        }, persona.storage);
    }

    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on('console', m => {
        if (m.type() === 'error' || m.type() === 'warning') {
            consoleErrors.push({ type: m.type(), text: m.text().slice(0, 400) });
        }
    });
    page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 400)));
    page.on('requestfailed', r => failedRequests.push({
        url: r.url(), reason: r.failure()?.errorText ?? 'unknown',
    }));

    if (persona.cpuThrottle) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: persona.cpuThrottle });
    }
    if (has('slow') || flag('slow', null)) {
        // playwright's slowMo is per-browser; emulate per-step pacing instead.
        page.setDefaultTimeout(10000);
    }

    let shotNo = 0;
    const notes = [];
    const ctx = {
        page, context, persona,
        note: text => { notes.push(text); console.log(`      · ${text}`); },
        shot: async name => {
            shotNo += 1;
            const file = join(dir, `${String(shotNo).padStart(2, '0')}-${name}.png`);
            await page.screenshot({ path: file }).catch(() => {});
        },
    };

    console.log(`\n=== ${persona.name} (${persona.id})`);
    const results = [];
    for (const name of persona.steps) {
        const step = STEPS[name];
        if (!step) { console.log(`  ?? unknown step "${name}"`); results.push({ step: name, ok: false, error: 'unknown step' }); continue; }
        const started = Date.now();
        const before = { c: consoleErrors.length, p: pageErrors.length, f: failedRequests.length };
        try {
            await step(ctx);
            results.push({
                step: name, ok: true, ms: Date.now() - started,
                newConsole: consoleErrors.length - before.c,
                newPageErrors: pageErrors.length - before.p,
                newFailedRequests: failedRequests.length - before.f,
            });
            console.log(`  ok   ${name} (${Date.now() - started}ms)`);
        } catch (e) {
            results.push({ step: name, ok: false, ms: Date.now() - started, error: String(e.message).split('\n')[0] });
            console.log(`  FAIL ${name}: ${String(e.message).split('\n')[0]}`);
        }
        await ctx.shot(name);
    }

    await context.tracing.stop({ path: join(dir, 'trace.zip') });
    await context.close();

    const report = { persona: persona.id, name: persona.name, story: persona.story, results, notes, pageErrors, consoleErrors, failedRequests };
    await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2));
    return report;
}

const personas = config.personas.filter(p => !wanted.length || wanted.includes(p.id));
if (!personas.length) {
    console.error(`No persona matched. Known: ${config.personas.map(p => p.id).join(', ')}`);
    process.exit(1);
}

// Fail early and loudly rather than giving every persona the same 20s timeout.
for (const [label, url] of [['dev server', `${BASE}/index.html`], ['decaid', `${DECAID}/api/v1/machine/state`]]) {
    const res = await fetch(url).catch(e => ({ ok: false, status: String(e.message) }));
    if (!res.ok) { console.error(`${label} not reachable at ${url} (${res.status})`); process.exit(1); }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: !has('headed') });
const reports = [];
for (const persona of personas) reports.push(await runPersona(browser, persona));
await browser.close();

await writeFile(join(OUT, 'report.json'), JSON.stringify(reports, null, 2));

console.log('\n--- summary');
for (const r of reports) {
    const failed = r.results.filter(s => !s.ok).map(s => s.step);
    const misses = r.notes.filter(n => n.startsWith('MISS')).length;
    console.log(
        `${r.persona.padEnd(7)} steps ${r.results.length - failed.length}/${r.results.length}` +
        `  pageErrors ${r.pageErrors.length}  console ${r.consoleErrors.length}` +
        `  netFail ${r.failedRequests.length}  missedElements ${misses}` +
        (failed.length ? `  failed: ${failed.join(',')}` : '')
    );
}
console.log(`\nartifacts: ${OUT}`);
console.log('trace:     npx playwright show-trace test/personas/out/<persona>/trace.zip');
