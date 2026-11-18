// Styled dropdown for native <select>s. The OS picker ignores the app's theme
// and looks different on every WebView, so each select gets an outlined
// trigger and an in-page option list drawn from the style guide (Figma
// 432:2710): Background.Primary panel, Border/Primary outline, the selected row
// in Action.Primary.Inactive with Action.Primary.Active text.
//
// The <select> stays in the DOM, hidden, and remains the source of truth:
// existing code keeps reading `.value` and listening for `change`, and a pick
// here sets the value and dispatches `change` exactly as the OS picker would.
// Nothing at module load touches the DOM, so the pure helper is node-testable.

const ENHANCED = 'customSelect';

// Next enabled option index for a key press, or null when the key does not
// move the selection. Disabled options are skipped; the ends do not wrap.
export function nextOptionIndex(disabledFlags, current, key) {
    const n = disabledFlags.length;
    const enabled = i => i >= 0 && i < n && !disabledFlags[i];
    const scan = (from, step) => {
        for (let i = from; i >= 0 && i < n; i += step) if (enabled(i)) return i;
        return null;
    };
    switch (key) {
        case 'ArrowDown': return scan(current + 1, 1) ?? (enabled(current) ? current : scan(0, 1));
        case 'ArrowUp': return scan(current - 1, -1) ?? (enabled(current) ? current : scan(n - 1, -1));
        case 'Home': return scan(0, 1);
        case 'End': return scan(n - 1, -1);
        default: return null;
    }
}

const CHEVRON = '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" class="flex-shrink-0 text-[var(--mimoja-blue-v2)]"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ACTIVE_CLASSES = ['ring-2', 'ring-inset', 'ring-[var(--mimoja-blue-v2)]'];

let openPanel = null;

function closeOpenPanel({ focusTrigger = false } = {}) {
    if (!openPanel) return;
    const { panel, trigger, teardown } = openPanel;
    openPanel = null;
    teardown();
    panel.remove();
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger.focus();
}

function enhance(select) {
    if (select.dataset[ENHANCED] || select.multiple || select.size > 1) return;
    select.dataset[ENHANCED] = '1';
    const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    const indexDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

    // The select's rendered width becomes a floor, not a fixed size: a fixed
    // width sized for the OS control truncates the label once a chevron sits
    // beside it.
    const minWidth = select.offsetWidth;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    for (const attr of ['aria-label', 'aria-labelledby']) {
        if (select.hasAttribute(attr)) trigger.setAttribute(attr, select.getAttribute(attr));
    }
    if (select.id) {
        // A <label for="id"> keeps naming the control after the select is hidden.
        const label = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
        if (label && !trigger.hasAttribute('aria-labelledby')) {
            if (!label.id) label.id = `${select.id}-label`;
            trigger.setAttribute('aria-labelledby', label.id);
        }
    }
    trigger.className = `custom-select-trigger min-w-[160px] max-w-full h-[62px] px-[20px] gap-[12px] flex items-center justify-between rounded-[10px] border-2 border-[var(--border-primary)] bg-[var(--card-bg)] text-[var(--text-primary)] text-[24px] font-normal text-left disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mimoja-blue-v2)]`;
    if (minWidth) trigger.style.minWidth = `${minWidth}px`;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'truncate';
    trigger.append(labelSpan);
    trigger.insertAdjacentHTML('beforeend', CHEVRON);

    const refresh = () => {
        const option = select.options[indexDescriptor.get.call(select)];
        labelSpan.textContent = option ? option.text : '';
        trigger.disabled = select.disabled;
    };

    // Code sets `select.value = x` after rendering, which fires no event; the
    // instance accessors keep the trigger's text in step with it.
    Object.defineProperty(select, 'value', {
        configurable: true,
        get() { return valueDescriptor.get.call(this); },
        set(v) { valueDescriptor.set.call(this, v); refresh(); },
    });
    Object.defineProperty(select, 'selectedIndex', {
        configurable: true,
        get() { return indexDescriptor.get.call(this); },
        set(v) { indexDescriptor.set.call(this, v); refresh(); },
    });
    // Options rebuilt, translated or the select disabled after render. The
    // observer goes with the select when the page drops it.
    new MutationObserver(refresh).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
    select.addEventListener('change', refresh);

    const choose = index => {
        if (index !== indexDescriptor.get.call(select)) {
            indexDescriptor.set.call(select, index);
            refresh();
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        closeOpenPanel({ focusTrigger: true });
    };

    const open = () => {
        if (trigger.disabled) return;
        closeOpenPanel();
        const panel = document.createElement('ul');
        panel.setAttribute('role', 'listbox');
        panel.tabIndex = -1;
        panel.className = 'custom-select-panel fixed z-[1000] max-h-[420px] overflow-y-auto rounded-[10px] border-2 border-[var(--border-primary)] bg-[var(--card-bg)] py-[8px] shadow-lg focus:outline-none';
        const selected = indexDescriptor.get.call(select);
        const disabledFlags = [...select.options].map(o => o.disabled);
        let active = selected >= 0 ? selected : nextOptionIndex(disabledFlags, -1, 'Home');

        const rows = [...select.options].map((option, i) => {
            const row = document.createElement('li');
            row.setAttribute('role', 'option');
            row.id = `custom-select-opt-${i}`;
            row.textContent = option.text;
            row.setAttribute('aria-selected', String(i === selected));
            if (option.disabled) row.setAttribute('aria-disabled', 'true');
            row.className = `px-[20px] py-[14px] text-[24px] cursor-pointer ${i === selected ? 'bg-[var(--dye-toggle-inactive-bg)] text-[var(--mimoja-blue-v2)] font-semibold' : 'text-[var(--text-primary)] font-normal hover:bg-[var(--bg-secondary)]'} ${option.disabled ? 'opacity-50 cursor-default' : ''}`;
            if (!option.disabled) row.addEventListener('click', () => choose(i));
            panel.append(row);
            return row;
        });

        const markActive = () => {
            rows.forEach((row, i) => ACTIVE_CLASSES.forEach(c => row.classList.toggle(c, i === active)));
            if (active != null && rows[active]) {
                panel.setAttribute('aria-activedescendant', rows[active].id);
                rows[active].scrollIntoView({ block: 'nearest' });
            }
        };

        // The app scales the whole page with a transform on #scaled-content, so
        // the list lives inside it (to get the same scale) and is positioned in
        // that element's unscaled coordinates. A transformed ancestor is the
        // containing block for `fixed`, so these offsets are relative to it.
        const host = trigger.closest('#scaled-content') || document.body;
        const hostRect = host.getBoundingClientRect();
        const scale = host === document.body ? 1 : (hostRect.width / host.offsetWidth) || 1;
        const r = trigger.getBoundingClientRect();
        const local = v => `${v / scale}px`;
        panel.style.minWidth = local(r.width);
        panel.style.left = local(r.left - hostRect.left);
        host.append(panel);
        // Opens downward unless the list would run off the bottom and there is
        // more room above.
        const below = window.innerHeight - r.bottom - 8;
        const height = panel.offsetHeight * scale;
        if (height > below && r.top > below) panel.style.top = local(r.top - hostRect.top - height - 4);
        else panel.style.top = local(r.bottom - hostRect.top + 4);
        markActive();

        const onKey = e => {
            if (e.key === 'Escape' || e.key === 'Tab') { closeOpenPanel({ focusTrigger: e.key === 'Escape' }); return; }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (active != null && !disabledFlags[active]) choose(active);
                return;
            }
            const next = nextOptionIndex(disabledFlags, active ?? -1, e.key);
            if (next != null) { e.preventDefault(); active = next; markActive(); }
        };
        const onOutside = e => { if (!panel.contains(e.target) && !trigger.contains(e.target)) closeOpenPanel(); };
        // The panel is fixed to the trigger's position at opening; a scroll or
        // resize would leave it floating, so either one closes it.
        const onMove = e => { if (!panel.contains(e.target)) closeOpenPanel(); };
        const onResize = () => closeOpenPanel();
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('scroll', onMove, true);
        window.addEventListener('resize', onResize);
        trigger.setAttribute('aria-expanded', 'true');
        openPanel = {
            panel, trigger,
            teardown: () => {
                document.removeEventListener('keydown', onKey, true);
                document.removeEventListener('pointerdown', onOutside, true);
                document.removeEventListener('scroll', onMove, true);
                window.removeEventListener('resize', onResize);
            },
        };
        panel.focus({ preventScroll: true });
    };

    trigger.addEventListener('click', () => (openPanel?.trigger === trigger ? closeOpenPanel() : open()));
    trigger.addEventListener('keydown', e => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
    });

    // Inline display, not just `hidden`: class CSS such as daisyUI's `.select`
    // sets its own display and would show the native control beside ours.
    select.hidden = true;
    select.style.setProperty('display', 'none', 'important');
    select.tabIndex = -1;
    select.after(trigger);
    refresh();
}

// Enhance every select under `root` (the root itself included) not already done.
export function enhanceSelects(root) {
    if (!root) return;
    if (root instanceof HTMLSelectElement) { enhance(root); return; }
    root.querySelectorAll?.('select').forEach(enhance);
}

// Enhance what `container` holds now and whatever is rendered into it later.
// Returns the cleanup, which also closes a list left open.
export function observeSelects(container) {
    if (!container) return () => {};
    enhanceSelects(container);
    const observer = new MutationObserver(records => {
        for (const record of records) {
            record.addedNodes.forEach(node => { if (node.nodeType === 1) enhanceSelects(node); });
        }
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => { observer.disconnect(); closeOpenPanel(); };
}
