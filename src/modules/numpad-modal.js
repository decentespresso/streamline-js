import { getValueFromStore, setValueInStore, getShots } from './api.js';
import { flashElement } from './ui.js';
import { getTranslation } from './i18n.js';
import { getTempUnit, boundToDisplay } from './units.js';
import { shouldUseNumpad } from './numpad-policy.js';

const fieldDisplayElementIds = {
    'dose-in': 'dose-in-value',
    'drink-out': 'drink-out-value',
    'temperature': 'temp-value',
    'grind': 'grind-value',
    'steam-duration': 'steam-duration-value',
    'steam-flow': 'steam-flow-value',
    'flush': 'flush-value',
    'hot-water-vol': 'hot-water-vol-value',
    'hot-water-temp': 'hot-water-temp-value',
};

let numpadModalInitialized = false;
let currentInputElement = null;
let currentValue = '0';
let originalValue = '0';
let previousValues = [];
let onConfirmCallback = null;
let isFirstInput = false;
let currentConfig = null;

async function getPreviousValues(fieldType) {
    try {
        const values = await getValueFromStore('numpad', `previous-values-${fieldType}`);
        return values || [];
    } catch {
        return [];
    }
}

async function savePreviousValue(fieldType, value) {
    try {
        const existing = await getPreviousValues(fieldType);
        const newList = [value, ...existing.filter(v => v !== value)].slice(0, 8);
        await setValueInStore('numpad', `previous-values-${fieldType}`, newList);
    } catch {}
}

async function getValuesFromShotHistory(fieldType, limit = 8) {
    try {
        const response = await getShots({ limit: 20 });
        
        // Handle paginated response: { shots: [...], total: X }
        // or direct array response
        let shots = [];
        if (Array.isArray(response)) {
            shots = response;
        } else if (response && Array.isArray(response.shots)) {
            shots = response.shots;
        } else return [];
        
        const values = [];
        shots.forEach(shot => {
            const workflow = shot.workflow || {};
            if (fieldType === 'dose-in' && workflow.doseData?.doseIn) {
                values.push(workflow.doseData.doseIn.toString());
            } else if (fieldType === 'drink-out' && workflow.doseData?.drinkOut) {
                values.push(workflow.doseData.drinkOut.toString());
            } else if (fieldType === 'grind' && workflow.grinderData?.setting) {
                values.push(workflow.grinderData.setting.toString());
            }
        });
        return [...new Set(values)].slice(0, limit);
    } catch {
        return [];
    }
}

// Debug function to test the modal - call this in browser console
window.testNumpadModal = function(force = true) {
    window._forceNumpadMobile = force;
    if (force) {
        initializeNumpadModal();
        
        const valueElements = [
            { id: 'dose-in-value', type: 'dose-in' },
            { id: 'drink-out-value', type: 'drink-out' },
            { id: 'temp-value', type: 'temperature' },
            { id: 'grind-value', type: 'grind' },
            { id: 'steam-duration-value', type: 'steam-duration' },
            { id: 'steam-flow-value', type: 'steam-flow' },
            { id: 'flush-value', type: 'flush' },
            { id: 'hot-water-vol-value', type: 'hot-water-vol' },
            { id: 'hot-water-temp-value', type: 'hot-water-temp' }
        ];
        
        valueElements.forEach(({ id, type }) => {
            const el = document.getElementById(id);
            if (!el) return;
            
            el.style.cursor = 'pointer';
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const currentValue = el.textContent.replace(/[^0-9.]/g, '') || '0';
                
                const mockInput = {
                    value: currentValue,
                    dispatchEvent: (event) => {
                        if (event.type === 'change' || event.type === 'input') {
                            const newVal = mockInput.value;
                            el.textContent = type === 'temperature' ? `${newVal}°c` : 
                                            type === 'grind' ? newVal : 
                                            type === 'steam-duration' ? `${newVal}s` :
                                            type === 'steam-flow' ? newVal :
                                            type === 'flush' ? `${newVal}s` :
                                            type === 'hot-water-vol' ? `${newVal}ml` :
                                            type === 'hot-water-temp' ? `${newVal}°c` :
                                            `${newVal}g`;
                        }
                    }
                };
                
                openModal(mockInput, { previousValues: [], fieldType: type });
            });
        });
    }
};

function createModalHTML() {
    const overlay = document.createElement('dialog');
    overlay.id = 'numpad-modal-overlay';
    overlay.className = 'numpad-modal-overlay';
    // showModal() otherwise autofocuses the first button (CANCEL) and paints a
    // focus ring on it -- which reads as a border the TCL page doesn't have.
    // openModal() moves focus here instead; ESC and Tab keep working.
    overlay.tabIndex = -1;

    // Full-screen layout on the top-layer <dialog>: the inner canvas is a fixed
    // 1920x1200 design surface (the sizes below and in numpad-modal.css are
    // design pixels) scaled to the viewport by scaleNumpadCanvas() — the same
    // visual as the original full-screen numpad, without the old #scaled-content
    // re-parenting.
    overlay.innerHTML = `
        <div class="numpad-modal-container">
            <div class="numpad-modal-scaled-inner">
                <div class="numpad-modal-header">
                    <span class="numpad-modal-title">DOSE</span>
                    <div class="numpad-modal-actions">
                        <button class="numpad-modal-cancel" id="numpad-cancel">CANCEL</button>
                        <button class="numpad-modal-confirm" id="numpad-confirm">CONFIRM</button>
                    </div>
                </div>

                <div class="numpad-modal-header-divider"></div>

                <div class="numpad-modal-content">
                    <div class="numpad-modal-left">
                        <div class="numpad-modal-input-section">
                            <span class="numpad-modal-input-label">Input value between 1–120</span>
                            <div class="numpad-modal-input-box">
                                <div class="numpad-modal-input-border"></div>
                                <span class="numpad-modal-input-value" id="numpad-display-value"></span>
                            </div>
                        </div>

                        <div class="numpad-previous-divider"></div>

                        <div class="numpad-modal-previous-values" id="numpad-previous-values-container" style="display: none;">
                            <div class="numpad-modal-previous-container">
                                <div class="numpad-modal-previous-title">Previous Values</div>
                                <div class="numpad-modal-previous-grid" id="numpad-previous-grid"></div>
                            </div>
                        </div>
                    </div>

                    <div class="numpad-modal-divider"></div>

                    <div class="numpad-modal-right">
                        <div class="numpad-modal-numpad">
                <button class="numpad-modal-numpad-btn" data-number="1">1</button>
                <button class="numpad-modal-numpad-btn" data-number="2">2</button>
                <button class="numpad-modal-numpad-btn" data-number="3">3</button>
                <button class="numpad-modal-numpad-btn" data-number="4">4</button>
                <button class="numpad-modal-numpad-btn" data-number="5">5</button>
                <button class="numpad-modal-numpad-btn" data-number="6">6</button>
                <button class="numpad-modal-numpad-btn" data-number="7">7</button>
                <button class="numpad-modal-numpad-btn" data-number="8">8</button>
                <button class="numpad-modal-numpad-btn" data-number="9">9</button>
                <button class="numpad-modal-numpad-btn numpad-decimal" data-action="decimal">.</button>
                <button class="numpad-modal-numpad-btn" data-number="0">0</button>
                <button class="numpad-modal-numpad-btn numpad-delete" data-action="delete">
                    <svg viewBox="0 0 54.8076 43.5" class="delete-icon-small"><path d="M49.9746 0C52.644 0 54.8076 2.16461 54.8076 4.83398V38.667C54.8074 41.3362 52.6439 43.5 49.9746 43.5H15.6025C14.3529 43.4999 13.1907 42.8565 12.5283 41.7969L0.799805 23.0312L0 21.75L0.799805 20.4697L12.5283 1.7041C13.1907 0.644322 14.3528 0.000123843 15.6025 0H49.9746ZM5.69922 21.75L16.2715 38.667H49.9746V4.83398H16.2715L5.69922 21.75ZM37.3906 12.791C38.3343 11.8474 39.8648 11.8475 40.8086 12.791C41.752 13.7348 41.7522 15.2653 40.8086 16.209L34.6631 22.3535L40.8086 28.499C41.752 29.4428 41.7522 30.9733 40.8086 31.917C39.8649 32.8607 38.3344 32.8604 37.3906 31.917L31.2451 25.7715L25.1006 31.917C24.1569 32.8607 22.6264 32.8604 21.6826 31.917C20.7391 30.9732 20.7389 29.4427 21.6826 28.499L27.8271 22.3535L21.6826 16.209C20.739 15.2652 20.7389 13.7347 21.6826 12.791C22.6264 11.8473 24.1568 11.8474 25.1006 12.791L31.2451 18.9355L37.3906 12.791Z" /></svg>
                        </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // 'close' fires on EVERY closure path, including ESC (which closes a native
    // <dialog> without going through closeModal) — restore page scroll there so
    // an ESC'd numpad can't leave the body stuck at overflow:hidden.
    overlay.addEventListener('close', () => {
        document.body.style.overflow = '';
    });

    window.addEventListener('resize', scaleNumpadCanvas);

    return overlay;
}

// Fit the fixed 1920x1200 design canvas to the viewport, mirroring scaling.js:
// on screens taller than 16:10 (4:3 iPads) keep the scale uniform and grow the
// canvas -- the keypad's absolute TCL coordinates stay put at the top and the
// white container simply fills the extra rows, so the page stays full-bleed
// instead of floating as a letterboxed card. On shorter screens (8" tablets at
// 1340x800) fall back to the independent x/y squash so they still fill.
function scaleNumpadCanvas() {
    const inner = document.querySelector('#numpad-modal-overlay .numpad-modal-scaled-inner');
    if (!inner) return;
    let sx = window.innerWidth / 1920;
    let sy = window.innerHeight / 1200;
    let canvasHeight = 1200;

    if (window.innerHeight / sx >= 1200) {
        sy = sx;
        canvasHeight = window.innerHeight / sx;
    } else {
        const MAX_STRETCH = parseFloat(localStorage.getItem('maxStretch') || '1.15');
        const stretch = Math.max(sx, sy) / Math.min(sx, sy);
        if (stretch > MAX_STRETCH) {
            const k = MAX_STRETCH / stretch;
            if (sx > sy) sx *= k; else sy *= k;
        }
    }

    // Placed explicitly from the top-left origin — see numpad-modal.css.
    const offsetX = (window.innerWidth - 1920 * sx) / 2;
    const offsetY = (window.innerHeight - canvasHeight * sy) / 2;
    inner.style.height = `${canvasHeight}px`;
    inner.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${sx}, ${sy})`;
}

function updateDisplay() {
    const displayElement = document.getElementById('numpad-display-value');
    if (!displayElement) return;
    // Prefer the live config set by openModal — covers caller-supplied fieldTypes
    // (e.g. 'pe-temp', 'pe-pump') that aren't keys in the static fieldConfig dict.
    const config = currentConfig || fieldConfig[currentFieldType] || fieldConfig['dose-in'];
    displayElement.innerHTML =
        `${currentValue}<span class="numpad-modal-input-cursor"></span><span class="numpad-unit-text">${config.unit}</span>`;
}

function handleNumberClick(num) {
    if (isFirstInput) {
        currentValue = num;
        isFirstInput = false;
    } else if (currentValue === '0' || currentValue === '') {
        currentValue = num;
    } else if (currentValue.length < 5) {
        currentValue = currentValue + num;
    }
    updateDisplay();
}

function handleDecimalClick() {
    if (isFirstInput) {
        currentValue = '0.';
        isFirstInput = false;
        updateDisplay();
    } else if (!currentValue.includes('.') && currentValue.length < 5) {
        currentValue = currentValue + '.';
        updateDisplay();
    }
}

function handleBackspace() {
    isFirstInput = false;
    if (currentValue.length > 0) {
        currentValue = currentValue.slice(0, -1);
        if (currentValue === '' || currentValue === '-') {
            currentValue = '0';
        }
        updateDisplay();
    }
}

function handlePreviousValue(value) {
    currentValue = value;
    isFirstInput = false;
    const displayId = fieldDisplayElementIds[currentFieldType];
    if (displayId) flashElement(document.getElementById(displayId));
    handleConfirm();
}

function renderPreviousValues() {
    const container = document.getElementById('numpad-previous-values-container');
    const grid = document.getElementById('numpad-previous-grid');

    if (!previousValues || previousValues.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';
    grid.innerHTML = '';

    // Up to 4 recent values, as two rows of two pills (the full-screen layout).
    const rows = [previousValues.slice(0, 2), previousValues.slice(2, 4)];
    rows.forEach(rowValues => {
        if (rowValues.length === 0) return;
        const row = document.createElement('div');
        row.className = 'numpad-previous-row';
        rowValues.forEach(value => {
            const btn = document.createElement('button');
            btn.className = 'numpad-modal-previous-btn';
            btn.textContent = value;
            btn.addEventListener('click', () => handlePreviousValue(value));
            row.appendChild(btn);
        });
        grid.appendChild(row);
    });
}

function getDesignScale() {
    const scaledContent = document.getElementById('scaled-content');
    if (!scaledContent) return 1;
    
    const style = window.getComputedStyle(scaledContent);
    const transform = style.transform;
    
    if (transform && transform !== 'none') {
        const match = transform.match(/matrix\(([^)]+)\)/);
        if (match) {
            return parseFloat(match[1].split(',')[0]) || 1;
        }
    }
    return 1;
}

let currentFieldType = 'dose-in';

const fieldConfig = {
    'dose-in': { title: 'DOSE', unit: 'g', defaultValue: '20', label: 'Input value between 1–120' },
    'drink-out': { title: 'DRINK OUT', unit: 'g', defaultValue: '40', label: 'Input value between 1–200' },
    'temperature': { title: 'TEMPERATURE', unit: '°c', defaultValue: '93', label: 'Input value between 70–110' },
    'grind': { title: 'GRIND', unit: '', defaultValue: '1', label: 'Input value between 0–9999' },
    'steam-duration': { title: 'STEAM DURATION', unit: 's', defaultValue: '30', label: 'Input value 0–120 (0 = steam off)' },
    'steam-flow': { title: 'STEAM FLOW', unit: 'ml/s', defaultValue: '1.0', label: 'Input value between 0.1–10.0' },
    'flush': { title: 'FLUSH', unit: 's', defaultValue: '5', label: 'Input value 0–60 (0 = no flush)' },
    'hot-water-vol': { title: 'HOT WATER VOL', unit: 'ml', defaultValue: '50', label: 'Input value 0–500 (0 = no limit)' },
    'hot-water-temp': { title: 'HOT WATER TEMP', unit: '°c', defaultValue: '85', label: 'Input value between 70–110' }
};

function getFieldDisplayValue(value, fieldType) {
    const config = fieldConfig[fieldType] || fieldConfig['dose-in'];
    return value + config.unit;
}

async function openModal(inputElement, options = {}) {
    if (!numpadModalInitialized) {
        initializeNumpadModal();
    }
    
    currentInputElement = inputElement;
    currentFieldType = options.fieldType || 'dose-in';

    let config = options.config || fieldConfig[currentFieldType] || fieldConfig['dose-in'];
    // 'temperature' / 'hot-water-temp' are Celsius-canonical fields shown in
    // whichever unit the user picked in Settings — resolve unit/bounds here so
    // every caller (main-page presets, mobile tap-to-edit) gets it for free.
    if (currentFieldType === 'temperature' || currentFieldType === 'hot-water-temp') {
        config = {
            ...config,
            unit: getTempUnit() === 'F' ? '°F' : '°c',
            defaultValue: String(boundToDisplay(Number(config.defaultValue))),
            label: `Input value between ${boundToDisplay(70)}–${boundToDisplay(110)}`,
        };
    }
    currentConfig = config;
    const inputValue = inputElement.value || inputElement.getAttribute('data-default') || config.defaultValue;
    // Remove any existing units for editing
    currentValue = inputValue.replace(/[g°cF]/g, '').trim() || config.defaultValue;
    originalValue = currentValue;
    
    isFirstInput = true;
    
    // Update modal title and label. Run both through i18n so the field name
    // and helper text follow the selected language (falls back to the English
    // string when a key isn't in the translation table).
    const titleEl = document.querySelector('.numpad-modal-title');
    if (titleEl) {
        titleEl.textContent = getTranslation(config.title);
    }

    const labelEl = document.querySelector('.numpad-modal-input-label');
    if (labelEl) {
        // Synthesize from min/max when caller supplied them so the helper text
        // always reflects the actual valid range + unit for the field.
        const hasRange = config.min !== undefined && config.max !== undefined;
        const labelText = hasRange
            ? `Input value between ${config.min}–${config.max}${config.unit ? ' ' + config.unit : ''}`
            : (config.label || '');
        labelEl.textContent = getTranslation(labelText);
    }
    
    // Load previous values
    let storedValues = await getPreviousValues(currentFieldType);
    
    // If no stored values and field supports shot history, get from shots
    if (storedValues.length === 0 && ['dose-in', 'drink-out', 'grind'].includes(currentFieldType)) {
        storedValues = await getValuesFromShotHistory(currentFieldType);
    }
    
    previousValues = storedValues.length > 0 ? storedValues : (options.previousValues || []);
    onConfirmCallback = options.onConfirm || null;
    
    const overlay = document.getElementById('numpad-modal-overlay');

    renderPreviousValues();
    updateDisplay();

    // The numpad is a top-layer <dialog>: it renders above everything (including
    // an open showModal() dialog like Add Schedule). The 1920x1200 design canvas
    // inside it is fitted to the viewport by scaleNumpadCanvas — no re-parenting
    // into #scaled-content, no OS-keyboard suppression.
    if (!overlay.open) overlay.showModal();
    // Take focus off CANCEL (see the autofocus note in createModalHTML). The
    // dialog itself holds it, so ESC still closes and Tab still works.
    overlay.focus();
    scaleNumpadCanvas();
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    const overlay = document.getElementById('numpad-modal-overlay');
    if (overlay.open) overlay.close();
    document.body.style.overflow = '';
}

function handleCancel() {
    currentValue = originalValue;
    closeModal();
}

function handleConfirm() {
    // Confirm what is on the display. This used to blank a bare "0" to '',
    // because handleBackspace() lands on "0" when the field is cleared and the
    // two states are indistinguishable in currentValue. But every caller reads
    // the result with parseFloat and drops NaN, so a deliberate 0 was silently
    // discarded -- e.g. 0 bar is how a flow step's pressure limit is switched
    // off, and entering it did nothing at all.
    const finalValue = currentValue;
    
    if (currentInputElement) {
        currentInputElement.value = finalValue;
        currentInputElement.dispatchEvent(new Event('change', { bubbles: true }));
        currentInputElement.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    // Save to previous values
    savePreviousValue(currentFieldType, finalValue);
    
    if (onConfirmCallback) {
        onConfirmCallback(finalValue);
    }
    
    closeModal();
}

function initializeNumpadModal() {
    if (numpadModalInitialized) return;
    
    createModalHTML();
    const closeBtn = document.getElementById('numpad-modal-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', handleCancel);
    }
    document.getElementById('numpad-cancel').addEventListener('click', handleCancel);
    document.getElementById('numpad-confirm').addEventListener('click', handleConfirm);
    
    const numpadButtons = document.querySelectorAll('.numpad-modal-numpad-btn[data-number]');
    numpadButtons.forEach(button => {
        button.addEventListener('click', () => {
            const number = button.getAttribute('data-number');
            handleNumberClick(number);
        });
    });
    
    document.querySelector('.numpad-modal-numpad-btn[data-action="decimal"]').addEventListener('click', handleDecimalClick);
    document.querySelector('.numpad-modal-numpad-btn[data-action="delete"]').addEventListener('click', handleBackspace);
    
    const overlay = document.getElementById('numpad-modal-overlay');
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            handleCancel();
        }
    });
    
    numpadModalInitialized = true;
}

function attachToNumericInputs(selector = 'input[type="number"]', options = {}) {
    if (!shouldUseNumpad()) return;
    
    const inputs = document.querySelectorAll(selector);
    
    inputs.forEach(input => {
        if (input.hasAttribute('data-numpad-attached')) return;
        
        input.setAttribute('data-numpad-attached', 'true');
        
        input.addEventListener('focus', (e) => {
            e.preventDefault();
            openModal(input, {
                previousValues: options.previousValues || [],
                onConfirm: options.onConfirm || null
            });
        });
        
        input.addEventListener('click', (e) => {
            openModal(input, {
                previousValues: options.previousValues || [],
                onConfirm: options.onConfirm || null
            });
        });
        
        input.readOnly = true;
        input.style.cursor = 'pointer';
    });
}

function initNumpadModal() {
    const shouldUse = shouldUseNumpad();
    
    if (shouldUse) {
        initializeNumpadModal();
    }
}

// Reset function to allow reinitialization after DOM changes (e.g., router page loads)
function resetNumpadModal() {
    numpadModalInitialized = false;
}

// Expose for manual testing in browser console
window.initNumpadModal = initNumpadModal;
window.openNumpadModal = openModal;
window.resetNumpadModal = resetNumpadModal;

export { initNumpadModal, attachToNumericInputs, openModal, shouldUseNumpad, initializeNumpadModal, resetNumpadModal };
