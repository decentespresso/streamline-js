import { streamDerekAnswer } from './api.js';
import { getTranslation } from './i18n.js';
import { loadStyle } from './vendor-loader.js';
import { buildShotQuery, buildFollowUpQuery, splitBold } from './derek-stream.js';
import { logger } from './logger.js';

// In-app Derek chat. Opens, sends the shot summary immediately, streams the
// answer, and accepts follow-ups. Lives inside #scaled-content (1920x1200
// design space) like the notes modal; closing aborts the stream and removes
// every node, so repeat opens are safe.

let overlayEl = null;
let abortCtl = null;

function renderMarkdown(el, text) {
    el.textContent = '';
    let list = null;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        const bullet = line.match(/^[-*]\s+(.*)/);
        if (!line) { list = null; continue; }
        let target;
        if (bullet) {
            if (!list) list = el.appendChild(document.createElement('ul'));
            target = list.appendChild(document.createElement('li'));
        } else {
            list = null;
            target = el.appendChild(document.createElement('p'));
        }
        for (const part of splitBold((bullet ? bullet[1] : line).replace(/^#+\s*/, ''))) {
            const node = part.bold ? document.createElement('strong') : document.createElement('span');
            node.textContent = part.text;
            target.appendChild(node);
        }
    }
}

function closeDerekModal() {
    abortCtl?.abort();
    abortCtl = null;
    overlayEl?.remove();
    overlayEl = null;
}

export function openDerekModal(summaryMd, { onOpenExternal } = {}) {
    closeDerekModal();
    loadStyle('src/css/derek-modal.css').catch(() => {});

    overlayEl = document.createElement('div');
    overlayEl.className = 'derek-modal-overlay';
    overlayEl.innerHTML = `
        <div class="derek-modal-container">
            <div class="derek-modal-header">
                <span class="derek-modal-title"><img class="derek-avatar" src="src/ui/derek.webp" alt=""><span></span></span>
                <div class="derek-modal-actions">
                    <a class="derek-modal-external" href="https://derek.decentespresso.com/" rel="noopener"></a>
                    <button type="button" class="derek-modal-close"></button>
                </div>
            </div>
            <div class="derek-modal-log"></div>
            <form class="derek-modal-form">
                <input type="text" class="derek-modal-input" autocomplete="off">
                <button type="submit" class="derek-modal-send"></button>
            </form>
        </div>`;
    const q = (s) => overlayEl.querySelector(s);
    q('.derek-modal-title span').textContent = 'Derek';
    q('.derek-modal-close').textContent = getTranslation('Close');
    // Plain same-frame anchor: the host opens the OS browser (no target=_blank,
    // it dies in the webview). The tap also copies the summary to paste there.
    q('.derek-modal-external').textContent = getTranslation('Open in browser');
    q('.derek-modal-external').addEventListener('click', () => onOpenExternal?.());
    q('.derek-modal-send').textContent = getTranslation('Send');
    q('.derek-modal-input').placeholder = getTranslation('Ask a follow-up question');
    q('.derek-modal-close').addEventListener('click', closeDerekModal);
    (document.getElementById('scaled-content') || document.body).appendChild(overlayEl);

    const log = q('.derek-modal-log');
    const input = q('.derek-modal-input');
    const send = q('.derek-modal-send');

    function addMsg(cls, text) {
        const el = document.createElement('div');
        el.className = `derek-msg ${cls}`;
        el.textContent = text;
        if (cls.includes('derek-msg-derek')) {
            const row = document.createElement('div');
            row.className = 'derek-row';
            const img = document.createElement('img');
            img.className = 'derek-avatar';
            img.src = 'src/ui/derek.webp';
            img.alt = '';
            row.append(img, el);
            log.appendChild(row);
        } else {
            log.appendChild(el);
        }
        log.scrollTop = log.scrollHeight;
        return el;
    }

    async function ask(query, shownText) {
        abortCtl?.abort();
        const ctl = abortCtl = new AbortController();
        send.disabled = true;
        if (shownText) addMsg('derek-msg-user', shownText);
        const reply = addMsg('derek-msg-derek derek-msg-status', getTranslation('Derek is thinking…'));
        let answer = '';
        try {
            await streamDerekAnswer(query, ({ event, data }) => {
                if (ctl.signal.aborted) return;
                if (event === 'delta' && data.text) {
                    answer += data.text;
                    reply.classList.remove('derek-msg-status');
                    renderMarkdown(reply, answer);
                } else if (event === 'result' && data.answer_text) {
                    reply.classList.remove('derek-msg-status');
                    renderMarkdown(reply, data.answer_text);
                }
                log.scrollTop = log.scrollHeight;
            }, ctl.signal);
            if (!answer && reply.classList.contains('derek-msg-status')) reply.textContent = getTranslation('No answer received');
        } catch (e) {
            if (ctl.signal.aborted) return;
            logger.error?.('Derek request failed', e);
            reply.classList.add('derek-msg-status');
            reply.textContent = getTranslation('Could not reach Derek');
        } finally {
            if (abortCtl === ctl) { send.disabled = false; abortCtl = null; }
        }
    }

    q('.derek-modal-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const question = input.value.trim();
        if (!question || send.disabled) return;
        input.value = '';
        ask(buildFollowUpQuery(summaryMd, question), question);
    });

    ask(buildShotQuery(summaryMd), getTranslation('Shot summary sent to Derek'));
}
