// Explainer-video rig: narrate the script with macOS `say`, drive the real skin
// in a real Chromium for exactly as long as each line takes, record the screen,
// then mux and letterbox to 1920x1080.
//
// ponytail: real-time recording, scene-level sync, no fake clock and no word
// timings. A line's audio sets its scene length, so the picture can only drift
// within a scene, never across the video. Move to frame-by-frame rendering if
// the Mac is too busy to record smoothly.
//
//   node test/personas/explainer.mjs
//   node test/personas/explainer.mjs --voice="Siri Voice 4"
//   node test/personas/explainer.mjs --audio-only      # just hear the script
//
// Needs MockDe1 connected in Decaid: it PUTs machine states, which on real
// hardware would run real water.

import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out', 'explainer');
// Qwen costs ~10s a line, so a clip is keyed by its words and reused until
// those words change.
const CACHE = join(HERE, 'out', 'voice-cache');
const sha = text => createHash('sha1').update(text).digest('hex').slice(0, 16);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const script = JSON.parse(await readFile(join(HERE, 'explainer.json'), 'utf8'));
const VOICE = flag('voice', script.voice);
const KOKORO = flag('kokoro', script.kokoro);
const QWEN = flag('qwen', script.qwen);
const AUDIO_ONLY = args.includes('--audio-only');
const BASE = flag('base', script.baseUrl);
const DECAID = flag('decaid', script.decaid);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (...parts) => console.log(...parts);

// ---------------------------------------------------------------- narration

async function duration(file) {
    const { stdout } = await run('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1', file,
    ]);
    return Number(stdout.trim());
}

// Kokoro when a model is configured, otherwise macOS `say`. Kokoro sounds
// markedly better; `say` needs nothing installed.
// John's cloned voice renders every line in one process: the model costs ~15s
// to load and the whole script is only a few minutes of speech.
async function speakAll(items) {
    const batch = join(OUT, 'batch.json');
    await writeFile(batch, JSON.stringify(items));
    await run(join(QWEN, '.venv-qwen/bin/python'), ['-I', join(QWEN, 'tts.py'), '--batch', batch],
        { maxBuffer: 1 << 24 });
}

async function speak(text, out) {
    if (KOKORO) {
        await run(join(KOKORO, 'venv/bin/python'), [
            '-I', join(KOKORO, 'tts.py'),
            '--voice', VOICE, '--speed', String(script.speed ?? 1),
            '-o', out, text,
        ]);
        return;
    }
    await run('say', [
        '-v', VOICE, '-r', String(script.rate),
        '--file-format=WAVE', '--data-format=LEI16@24000',
        '-o', out, text,
    ]);
}

async function narrate() {
    if (QWEN) {
        const items = [];
        let i = 0;
        for (const scene of script.scenes)
            for (const line of scene.lines)
                if (line.say) items.push({ out: join(CACHE, `${sha(line.say)}.wav`), text: line.say });
        const missing = items.filter(it => !existsSync(it.out));
        say(`  ${items.length} lines, ${missing.length} to render in John's voice`);
        if (missing.length) await speakAll(missing);
    }
    const scenes = [];
    let n = 0;
    for (const scene of script.scenes) {
        const lines = [];
        let at = 0;
        for (const line of scene.lines) {
            let length = line.hold ?? 0;
            let file = null;
            if (line.say) {
                n++;
                file = QWEN ? join(CACHE, `${sha(line.say)}.wav`)
                            : join(OUT, `${String(n).padStart(2, '0')}-${scene.id}.wav`);
                if (!QWEN) await speak(line.say, file);
                length = await duration(file) + script.gap;
            }
            lines.push({ ...line, at, length, file });
            at += length;
        }
        const length = at + script.tail;
        // One padded WAV per scene, so a scene's picture can never drift into
        // the next one however long a step takes.
        const list = join(OUT, `${scene.id}.txt`);
        const parts = [];
        for (const line of lines) {
            if (line.file) parts.push(line.file);
            const silence = line.file ? script.gap : line.length;
            if (silence > 0) {
                const quiet = join(OUT, `q-${parts.length}-${scene.id}.wav`);
                await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
                    '-i', `anullsrc=r=24000:cl=mono`, '-t', silence.toFixed(3), quiet]);
                parts.push(quiet);
            }
        }
        await writeFile(list, parts.map(f => `file '${f}'`).join('\n'));
        const padded = join(OUT, `${scene.id}.pad.wav`);
        await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0',
            '-i', list, '-af', 'apad', '-t', length.toFixed(3), padded]);
        scenes.push({ ...scene, lines, length, padded });
        say(`  ${scene.id.padEnd(12)} ${length.toFixed(1)}s over ${lines.length} lines`);
    }
    const list = join(OUT, 'narration.txt');
    await writeFile(list, scenes.map(s => `file '${s.padded}'`).join('\n'));
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list,
        join(OUT, 'narration.wav')]);
    return scenes;
}

// ---------------------------------------------------------------- the rig

// Nearly every customer machine has a group-head controller, so the skin must
// hide its on-screen control column. A Decaid build whose mock already reports
// GHC true needs nothing; otherwise flip it on the wire.
async function forceGhc(page) {
    const info = await (await fetch(`${DECAID}/api/v1/machine/info`)).json();
    if (info.GHC === true) {
        say(`GHC true from Decaid (${info.model}, ${info.serialNumber})`);
        return;
    }
    say(`GHC false from Decaid (${info.model}); overriding the response`);
    await page.route('**/api/v1/machine/info', async route => {
        const res = await route.fetch();
        await route.fulfill({ json: { ...(await res.json()), GHC: true } });
    });
}

const OVERLAY = `
#__ex_outline {
    position: fixed; z-index: 2147483647; pointer-events: none;
    border: 4px solid #e53935; border-radius: 10px;
    box-shadow: 0 0 0 2px rgba(0,0,0,.35);
    transition: all .35s ease; opacity: 0;
}`;

async function installOverlay(page) {
    const hide = (script.hide ?? []).join(', ');
    await page.addStyleTag({ content: OVERLAY + (hide ? `\n${hide} { display: none !important; }` : '') });
    await page.evaluate(() => {
        document.getElementById('__ex_outline')?.remove();
        const box = document.createElement('div');
        box.id = '__ex_outline';
        document.body.appendChild(box);
        // A selector list outlines all of them at once: "steam, flush and hot
        // water" wants one box around the three, not a box on the first.
        window.__exOutline = (selector, textOnly) => {
            const els = [...document.querySelectorAll(selector)].filter(e => e.getClientRects().length);
            if (!els.length) return false;
            // A wide container with a short label (the machine status is a 556px
            // right-aligned box) should be outlined around its words, not its box.
            const rectOf = el => {
                if (textOnly) {
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    const r = range.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return r;
                }
                return el.getBoundingClientRect();
            };
            const boxes = els.map(rectOf);
            const pad = 6;
            const left = Math.max(pad, Math.min(...boxes.map(b => b.left)) - pad);
            const top = Math.max(pad, Math.min(...boxes.map(b => b.top)) - pad);
            const right = Math.min(window.innerWidth - pad, Math.max(...boxes.map(b => b.right)) + pad);
            const bottom = Math.min(window.innerHeight - pad, Math.max(...boxes.map(b => b.bottom)) + pad);
            Object.assign(box.style, {
                left: `${left}px`, top: `${top}px`,
                width: `${Math.max(0, right - left)}px`,
                height: `${Math.max(0, bottom - top)}px`,
                opacity: '1',
            });
            return true;
        };
        window.__exClear = () => { box.style.opacity = '0'; };
    });
}

// Playwright scrolls an element into view before clicking it, which slides a
// fixed tablet layout sideways and crops the left column. Put it back.
async function resetScroll(page) {
    await page.evaluate(() => {
        const el = document.scrollingElement;
        if (el) { el.scrollLeft = 0; el.scrollTop = 0; }
    });
}

async function machineState(state) {
    const res = await fetch(`${DECAID}/api/v1/machine/state/${state}`, { method: 'PUT' });
    if (!res.ok) say(`  ! machine/state/${state} -> ${res.status}`);
}

// Refuse to drive anything but the mock: these PUTs pull real water on a real
// machine.
async function requireMock() {
    const devices = await (await fetch(`${DECAID}/api/v1/devices`)).json();
    const machine = devices.find(d => d.type === 'machine' && d.state === 'connected');
    if (machine?.id !== 'MockDe1') {
        throw new Error(
            `Connected machine is ${machine?.id ?? 'none'}, not MockDe1. ` +
            `Enable the simulated machine in Decaid settings before filming.`
        );
    }
}

const OPS = {
    outlineText: (page, selector) => OPS.outline(page, selector, true),
    outline: async (page, selector, textOnly = false) => {
        const alive = await page.evaluate(() => typeof window.__exOutline === 'function');
        if (!alive) await installOverlay(page);
        if (!await page.evaluate(([s, t]) => window.__exOutline(s, t), [selector, textOnly])) {
            say(`  ! outline missed ${selector}`);
        }
    },
    clear: page => page.evaluate(() => window.__exClear?.()),
    // Playwright's actionability checks refuse a control the skin animates or
    // overlaps; the picture still has to show the tap, so fall back to the
    // element's own click.
    tap: async (page, selector) => {
        try {
            await page.locator(selector).first().click({ timeout: 2000 });
            return;
        } catch { /* fall through */ }
        const hit = await page.evaluate(s => {
            const el = document.querySelector(s);
            if (!el) return false;
            el.click();
            return true;
        }, selector);
        if (!hit) say(`  ! tap missed ${selector}`);
        else say(`  ~ tap fell back to DOM click: ${selector}`);
    },
    state: (_page, state) => machineState(state),
    press: async (page, selector) => {
        const el = page.locator(selector).first();
        const box = await el.boundingBox();
        if (!box) { say(`  ! press missed ${selector}`); return; }
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await sleep(900); // LONG_PRESS_MS is 500
        await page.mouse.up();
    },
};

async function film(scenes) {
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const context = await browser.newContext({
        viewport: script.viewport,
        recordVideo: { dir: OUT, size: script.viewport },
    });
    const page = await context.newPage();
    const recStart = Date.now();
    // ponytail: pin the preference instead of changing the user's real setting.
    // settingsSync would otherwise pull the synced value back over it at boot.
    await page.addInitScript(pinned => {
        for (const [k, v] of Object.entries(pinned)) localStorage.setItem(k, v);
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
            write.call(this, k, k in pinned ? pinned[k] : v);
        };
        // settingsSync applies Decaid's synced theme straight onto data-theme,
        // which never goes through setItem, so hold the attribute instead.
        const theme = pinned.theme;
        if (!theme) return;
        const root = document.documentElement;
        const hold = () => {
            if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
        };
        hold();
        new MutationObserver(hold).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    }, script.localStorage ?? {});
    await forceGhc(page);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#main-page', { timeout: 30000 });
    await installOverlay(page);
    await sleep(2000); // the first second of any screencast is choppy
    // The tutorial opens on a woken machine; waking is set-up, not a step.
    await machineState('idle');
    await sleep(1500);
    // Set-up happens off camera, inside the lead-in that gets trimmed.
    for (const [op, arg] of script.setup ?? []) await OPS[op](page, arg);
    if (script.setup?.length) { await resetScroll(page); await sleep(800); }
    const lead = (Date.now() - recStart) / 1000;

    for (const scene of scenes) {
        const start = Date.now();
        say(`> ${scene.id}`);
        for (const line of scene.lines) {
            const wait = start + line.at * 1000 - Date.now();
            if (wait > 0) await sleep(wait);
            for (const [op, arg] of line.do ?? []) await OPS[op](page, arg);
            if (line.do?.some(([op]) => op === 'tap')) {
                await resetScroll(page);
                for (const [op, arg] of line.do) if (op === 'outline') await OPS[op](page, arg);
            }
        }
        const left = start + scene.length * 1000 - Date.now();
        if (left > 0) await sleep(left);
        else say(`  ! ${scene.id} ran ${(-left / 1000).toFixed(1)}s past its narration`);
    }

    await machineState('idle');
    const video = page.video();
    await context.close();
    await browser.close();
    say(`lead-in trimmed: ${lead.toFixed(1)}s`);
    return { path: await video.path(), lead };
}

// ---------------------------------------------------------------- assemble

async function assemble(webm, lead, total) {
    const { width, height } = script.output;
    const inner = Math.round((height * script.viewport.width) / script.viewport.height / 2) * 2;
    const pad = Math.round((width - inner) / 2);
    const out = join(OUT, 'explainer.mp4');
    await run('ffmpeg', [
        '-y', '-ss', lead.toFixed(3), '-i', webm, '-i', join(OUT, 'narration.wav'),
        '-vf', `scale=${inner}:${height},pad=${width}:${height}:${pad}:0:black`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k',
        '-t', total.toFixed(3), '-movflags', '+faststart', out,
    ]);
    return out;
}

// ---------------------------------------------------------------- go

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await mkdir(CACHE, { recursive: true });

say(`voice: ${VOICE}`);
const scenes = await narrate();
const total = scenes.reduce((n, s) => n + s.length, 0);
say(`script: ${total.toFixed(1)}s over ${scenes.length} scenes`);

if (AUDIO_ONLY) {
    say(`narration: ${join(OUT, 'narration.wav')}`);
    process.exit(0);
}

await requireMock();
const { path: webm, lead } = await film(scenes);
const mp4 = await assemble(webm, lead, total);
say(`done: ${mp4}`);
