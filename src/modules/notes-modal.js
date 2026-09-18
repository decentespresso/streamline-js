import { loadEasyMDE, loadStyle } from './vendor-loader.js';

loadStyle('src/css/notes-modal.css').catch(() => {});

// ─── Notes Modal ───────────────────────────────────────────────────────────
// Full-screen markdown editor modal using EasyMDE.
// Appended inside #scaled-content so it shares the 1920x1200 design space.
// The EasyMDE editor sits in an absolutely-positioned inner div with an
// inverse scale transform so CodeMirror cursor math stays correct, while
// the header/buttons remain in the normal flex flow (never pushed off-screen).

let overlayEl = null;
let editorWrapEl = null;   // flex slot (position: relative)
let editorScaledEl = null; // absolutely-positioned, inverse-scaled inner div
let easyMDE = null;
let onConfirmCallback = null;
let subjectContainerEl = null;
let scaleUpdateHandler = null;

function getAppScale() {
    const content = document.getElementById('scaled-content');
    if (!content) return 1;
    const transform = content.style.transform || '';
    // scaling.js emits scale(sx, sy) — first number is the horizontal factor.
    const match = transform.match(/scale\(([\d.]+)/);
    return match ? parseFloat(match[1]) : 1;
}

function buildModal() {
    // If the overlay was detached from DOM (router wipes #scaled-content on navigation),
    // tear down stale references so we rebuild fresh.
    if (overlayEl && !overlayEl.isConnected) {
        if (easyMDE) {
            easyMDE.toTextArea();
            easyMDE = null;
        }
        overlayEl = null;
        editorWrapEl = null;
        editorScaledEl = null;
        subjectContainerEl = null;
    }
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.className = 'notes-modal-overlay';

    const container = document.createElement('div');
    container.className = 'notes-modal-container';

    // ── Header ──────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'notes-modal-header';

    const title = document.createElement('span');
    title.className = 'notes-modal-title';
    title.textContent = 'Notes';

    const actions = document.createElement('div');
    actions.className = 'notes-modal-header-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'notes-modal-cancel';
    cancelBtn.textContent = 'CANCEL';
    cancelBtn.addEventListener('click', closeModal);

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'notes-modal-confirm';
    confirmBtn.textContent = 'CONFIRM';
    confirmBtn.addEventListener('click', handleConfirm);

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    header.appendChild(title);
    header.appendChild(actions);

    // ── Subject row (hidden by default) ─────────────────────────────────────
    subjectContainerEl = document.createElement('div');
    subjectContainerEl.className = 'notes-modal-subject';
    subjectContainerEl.style.display = 'none';

    const subjectInput = document.createElement('input');
    subjectInput.type = 'text';
    subjectInput.id = 'notes-modal-subject-input';
    subjectInput.className = 'notes-modal-subject-input';
    subjectContainerEl.appendChild(subjectInput);

    // ── Editor area ─────────────────────────────────────────────────────────
    // Outer wrapper: flex slot that takes remaining space, acts as position anchor
    editorWrapEl = document.createElement('div');
    editorWrapEl.className = 'notes-modal-editor-wrap';

    // Inner wrapper: absolutely positioned, gets the inverse scale transform
    editorScaledEl = document.createElement('div');
    editorScaledEl.className = 'notes-modal-editor-scaled';

    const textarea = document.createElement('textarea');
    textarea.id = 'notes-modal-textarea';
    editorScaledEl.appendChild(textarea);
    editorWrapEl.appendChild(editorScaledEl);

    // ── Assemble ────────────────────────────────────────────────────────────
    container.appendChild(header);
    container.appendChild(subjectContainerEl);
    container.appendChild(editorWrapEl);
    overlayEl.appendChild(container);

    // Append inside #scaled-content so buttons/text match the design-space sizing
    const scaledContent = document.getElementById('scaled-content');
    if (scaledContent) {
        scaledContent.appendChild(overlayEl);
    } else {
        document.body.appendChild(overlayEl);
    }

    // ── Inject subject input styles once ────────────────────────────────────
    if (!document.getElementById('notes-modal-subject-styles')) {
        const style = document.createElement('style');
        style.id = 'notes-modal-subject-styles';
        style.textContent = `
            .notes-modal-subject { padding: 0 24px 12px; }
            .notes-modal-subject-input {
                width: 100%;
                height: 56px;
                padding: 0 20px;
                border-radius: 12px;
                border: 2px solid #385a92;
                background: var(--box-color, #fff);
                color: var(--text-primary, #000);
                font-size: 22px;
                outline: none;
                box-sizing: border-box;
            }
        `;
        document.head.appendChild(style);
    }
}

function applyInverseScale() {
    if (!editorScaledEl || !editorWrapEl) return;
    const scale = getAppScale();
    if (scale && scale !== 1) {
        const inv = 1 / scale;
        // The wrap's layout size is in design-space pixels (e.g. ~1040px tall).
        // We need the inner div to be wrap-size / scale in CSS pixels so that
        // after transform: scale(inv) it visually fills the wrap exactly.
        const wrapRect = editorWrapEl.getBoundingClientRect();
        const cssWidth = wrapRect.width / scale;   // undo parent scale to get design px
        const cssHeight = wrapRect.height / scale;

        editorScaledEl.style.width = `${cssWidth * (1 / inv)}px`;
        editorScaledEl.style.height = `${cssHeight * (1 / inv)}px`;
        editorScaledEl.style.transform = `scale(${inv})`;
        editorScaledEl.style.transformOrigin = 'top left';
    } else {
        // No scaling needed — fill the wrapper naturally
        editorScaledEl.style.width = '100%';
        editorScaledEl.style.height = '100%';
        editorScaledEl.style.transform = '';
    }
}

async function initEasyMDE() {
    if (easyMDE) return easyMDE;

    const textarea = document.getElementById('notes-modal-textarea');
    if (!textarea) return null;

    try {
        const EasyMDE = await loadEasyMDE();
        if (!textarea.isConnected || !overlayEl?.classList.contains('active')) return null;
        easyMDE = new EasyMDE({
            element: textarea,
            spellChecker: false,
            status: false,
            autoDownloadFontAwesome: false,
            placeholder: 'Write your notes here\u2026',
            toolbar: [
                'bold', 'italic', 'heading', '|',
                'unordered-list', 'ordered-list', '|',
                'link', 'quote', 'horizontal-rule', '|',
                'preview', 'side-by-side',
            ],
            autosave: {
                enabled: true,
                uniqueId: 'profile-notes-autosave',
                delay: 5000,
            },
            minHeight: '100%',
            maxHeight: '100%',
        });
        return easyMDE;
    } catch (error) {
        console.error('EasyMDE failed to load; using the plain notes editor.', error);
        textarea.focus();
        return null;
    }
}

// ── Open / Close ────────────────────────────────────────────────────────────

export function openNotesModal(currentText, onConfirm, options = {}) {
    buildModal();
    onConfirmCallback = onConfirm;
    overlayEl.classList.add('active');
    const textarea = document.getElementById('notes-modal-textarea');
    if (easyMDE) easyMDE.value(currentText || '');
    else if (textarea) textarea.value = currentText || '';

    // Update title if provided
    const titleEl = overlayEl.querySelector('.notes-modal-title');
    if (titleEl) titleEl.textContent = options.title || 'Notes';

    // Show/hide subject field
    const subjectInputEl = document.getElementById('notes-modal-subject-input');
    if (options.subject !== undefined && subjectContainerEl && subjectInputEl) {
        subjectContainerEl.style.display = 'block';
        subjectInputEl.value = options.subject || '';
        subjectInputEl.placeholder = options.subjectPlaceholder || 'Subject…';
    } else if (subjectContainerEl) {
        subjectContainerEl.style.display = 'none';
    }

    // Re-layout whenever the app scale changes (e.g. soft keyboard appears/hides).
    if (scaleUpdateHandler) {
        document.removeEventListener('streamline:scaleupdate', scaleUpdateHandler);
    }
    scaleUpdateHandler = () => {
        applyInverseScale();
        easyMDE?.codemirror?.refresh();
    };
    document.addEventListener('streamline:scaleupdate', scaleUpdateHandler);

    // Wait a frame for the overlay to be visible and laid out,
    // then compute inverse scale and init EasyMDE
    requestAnimationFrame(() => {
        applyInverseScale();
        setTimeout(async () => {
            const editor = await initEasyMDE();
            if (editor) {
                editor.codemirror.refresh();
                editor.codemirror.focus();
            } else {
                document.getElementById('notes-modal-textarea')?.focus();
            }
        }, 350);
    });
}

function handleConfirm() {
    if (onConfirmCallback) {
        const subjectInputEl = document.getElementById('notes-modal-subject-input');
        const value = easyMDE?.value() ?? document.getElementById('notes-modal-textarea')?.value ?? '';
        const showingSubject = subjectContainerEl && subjectContainerEl.style.display !== 'none';
        if (showingSubject && subjectInputEl) {
            onConfirmCallback({ subject: subjectInputEl.value, body: value });
        } else {
            onConfirmCallback(value);
        }
    }
    closeModal();
}

function closeModal() {
    if (!overlayEl) return;
    overlayEl.classList.remove('active');
    onConfirmCallback = null;
    if (scaleUpdateHandler) {
        document.removeEventListener('streamline:scaleupdate', scaleUpdateHandler);
        scaleUpdateHandler = null;
    }
}
