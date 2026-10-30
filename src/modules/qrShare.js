import { logger } from './logger.js';
import { loadQrCodeGen } from './vendor-loader.js';

// Share a profile as a QR code + short link.
//
// The profile itself still travels gzipped and base64url'd, same as always.
// What changed: instead of putting that payload straight in the URL fragment
// (`https://…/#H4sIA…`, 700-2000+ characters — fine for a camera, useless
// pasted into a chat), it is POSTed once to the caprover-share app's
// short-link store (caprover-share/server.js) and the `.../s/<id>` that comes
// back is what gets QR-coded and copied. See that file's header for what the
// store does and does not guarantee (no auth, no expiry).
//
// If the store is unreachable (offline, CORS, deploy down), buildShareUrl
// falls back to the old self-contained long link — still a fragment the
// decoder (docs/share.html) reads with no server involved at all, just capped
// by the QR byte budget below. `notes` is dropped only in that fallback, and
// only if the profile still doesn't fit.
//
// Profiles compress hard — every profile bundled with this skin lands between
// 448 and 1992 bytes against a 2953-byte QR budget — so the fallback link
// fits with room to spare in the common case.
//
// `qrcodegen` is a vendored global (src/vendor/qrcodegen.js, classic <script>,
// not a module) — see that file's header for provenance. Not imported: a
// plain <script> global is visible to modules the same way ReconnectingWebSocket
// and EasyMDE are used elsewhere in this codebase.

// Receiver page. Serves docs/share.html — deployed to CapRover from
// caprover-share/ (as index.html, hence the bare trailing slash), with the same
// file also published on GitHub Pages at
// https://allofmeng.github.io/MSL/share.html as a mirror.
//
// Self-hosted rather than on Pages because *.github.io is unreliable from
// mainland China, and the sender cannot know where the scanner will be. Any
// copy of the page decodes any link: the profile is in the fragment, so a host
// change never invalidates a code that is already out there.
export const SHARE_BASE_URL = 'https://qrshare.c48.cal.decentespresso.com/';

// QR byte mode at LOW ecc tops out at 2953 bytes. qrcodegen raises the error
// correction for free when the data leaves room, so LOW is a floor on quality,
// not a ceiling.
const QR_BYTE_CAPACITY = 2953;

const QR_QUIET_ZONE = 4;  // modules of white border — the QR spec's minimum
// Backing-store pixels per module. The canvas is scaled to a fixed CSS size, so
// this controls crispness, not how large the code appears on screen.
const QR_MODULE_PX = 8;

// On-screen pixels per module. A phone camera needs roughly 3 to reliably
// resolve one, and a full profile runs to 149 modules plus the quiet zone — at
// the old fixed 320px that was 2.0 per module, which is where scans fail.
const QR_DISPLAY_PX_PER_MODULE = 4;
const QR_DISPLAY_MIN = 320;
// The tablet's design canvas is 800px tall and the modal has to fit inside it
// with its title and buttons, so this ceiling is set by the screen, not by what
// a camera would prefer. At the densest profile (157 modules including the quiet
// zone) it still leaves 3.3px per module.
const QR_DISPLAY_MAX = 520;

function renderQrToCanvas(qr, canvas) {
    const modules = qr.size + QR_QUIET_ZONE * 2;
    canvas.width = modules * QR_MODULE_PX;
    canvas.height = modules * QR_MODULE_PX;
    // Sized by module count, not fixed: a small profile stays compact and a
    // dense one grows instead of becoming unscannable.
    const display = Math.min(QR_DISPLAY_MAX, Math.max(QR_DISPLAY_MIN, modules * QR_DISPLAY_PX_PER_MODULE));
    canvas.style.width = `${display}px`;
    canvas.style.height = `${display}px`;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) {
            if (qr.getModule(x, y)) {
                ctx.fillRect((x + QR_QUIET_ZONE) * QR_MODULE_PX, (y + QR_QUIET_ZONE) * QR_MODULE_PX, QR_MODULE_PX, QR_MODULE_PX);
            }
        }
    }
}

function toBase64Url(bytes) {
    let binary = '';
    // Chunked so a large profile cannot reach the argument-count limit of
    // String.fromCharCode.apply.
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// gzip where the platform has it, plain UTF-8 otherwise. The receiver sniffs the
// gzip magic bytes and handles both, so a WebView without CompressionStream
// still produces a working link — just a longer one.
async function encodeBody(text) {
    const raw = new TextEncoder().encode(text);
    if (typeof CompressionStream !== 'function') {
        logger.warn('CompressionStream unavailable — sharing an uncompressed profile.');
        return raw;
    }
    try {
        const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
        logger.warn('gzip failed, sharing uncompressed:', e);
        return raw;
    }
}

// POSTs the fragment to the short-link store and returns `.../s/<id>`, or
// null on any failure — offline, CORS, store down. A nicety the feature
// should degrade past, never break on.
async function shorten(fragment) {
    try {
        const res = await fetch(`${SHARE_BASE_URL}api/s`, { method: 'POST', body: fragment });
        if (!res.ok) return null;
        const id = (await res.text()).trim();
        return id ? `${SHARE_BASE_URL}s/${id}` : null;
    } catch (e) {
        logger.warn('Short link store unreachable, using the long link:', e);
        return null;
    }
}

/**
 * Build the share URL for a profile.
 * @returns {Promise<{url: string, notesDropped: boolean}|null>} null when even
 *          the trimmed profile will not fit in a QR code (only reachable when
 *          the short-link store is also unreachable).
 */
export async function buildShareUrl(profile) {
    const attempt = async (body) => {
        const fragment = toBase64Url(await encodeBody(JSON.stringify(body)));
        const short = await shorten(fragment);
        if (short) return { url: short, notesDropped: false };

        const long = `${SHARE_BASE_URL}#${fragment}`;
        return long.length <= QR_BYTE_CAPACITY ? { url: long, notesDropped: false } : null;
    };

    const full = await attempt(profile);
    if (full) return full;

    // Notes are the one field that is usually large and never needed to pull the
    // shot, so they are the only thing dropped before giving up.
    if (!profile.notes) return null;
    const { notes, ...trimmed } = profile;
    const short = await attempt(trimmed);
    return short ? { ...short, notesDropped: true } : null;
}

// The link currently on screen, for the Copy button.
let currentShareUrl = null;

export async function showProfileQrModal(profile) {
    const modal = document.getElementById('qr-share-modal');
    const canvas = document.getElementById('qr-share-canvas');
    const warningEl = document.getElementById('qr-share-warning');
    const tooBigEl = document.getElementById('qr-share-too-big');
    const hostEl = document.getElementById('qr-share-host');
    const copyBtn = document.getElementById('qr-share-copy');
    if (!modal || !canvas) {
        logger.error('QR share modal markup not found.');
        return;
    }

    const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };

    let result = null;
    try {
        result = await buildShareUrl(profile);
    } catch (e) {
        logger.error('Could not build the share link:', e);
    }

    currentShareUrl = result?.url ?? null;

    if (!result) {
        show(canvas, false);
        show(warningEl, false);
        show(hostEl, false);
        show(copyBtn, false);
        show(tooBigEl, true);
        modal.showModal();
        return;
    }

    show(canvas, true);
    show(tooBigEl, false);
    show(warningEl, result.notesDropped);
    // A shortened link is short enough to print in full; the long fallback
    // (700-2000 characters) is not — nobody reads that out, and it pushed the
    // modal off the screen — so that case still shows just the host. Either
    // way the link is also on the clipboard for sending through a chat app on
    // this tablet instead of by camera.
    if (hostEl) {
        const shareUrl = new URL(result.url);
        hostEl.textContent = shareUrl.pathname.startsWith('/s/') ? result.url : shareUrl.host;
        show(hostEl, true);
    }
    show(copyBtn, true);
    try {
        // Fetched on the first share rather than at boot (vendor-loader.js).
        // Throws if it cannot be loaded, rather than leaving an empty white
        // square with no explanation.
        const qrcodegen = await loadQrCodeGen();
        renderQrToCanvas(qrcodegen.QrCode.encodeText(result.url, qrcodegen.QrCode.Ecc.LOW), canvas);
    } catch (e) {
        logger.error('Could not draw the QR code:', e);
        show(canvas, false);
    }
    modal.showModal();
}

// navigator.clipboard is gated on a secure context, and the skin is served over
// plain http from Decaid on :3000 -- so on the tablet it is simply absent. The
// execCommand path is the one that actually runs there.
function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    try {
        if (!document.execCommand('copy')) throw new Error('copy rejected');
        return Promise.resolve();
    } catch (e) {
        return Promise.reject(e);
    } finally {
        ta.remove();
    }
}

export function initQrShareModal() {
    const copyBtn = document.getElementById('qr-share-copy');
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            if (!currentShareUrl) return;
            const original = copyBtn.textContent;
            try {
                await copyToClipboard(currentShareUrl);
                copyBtn.textContent = 'Copied';
            } catch (e) {
                logger.warn('Clipboard copy failed:', e);
                copyBtn.textContent = 'Copy failed';
            }
            setTimeout(() => { copyBtn.textContent = original; }, 2000);
        });
    }
}
