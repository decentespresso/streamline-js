import * as ui from '../../modules/ui.js';
import { translatePage } from '../../modules/i18n.js';
import { getSnapshot, subscribe, updateReaSetting } from '../settings-data.js';

const FIELDS = Object.freeze({
    weightFlowMultiplier: Object.freeze({ step: 0.1, digits: 1 }),
    volumeFlowMultiplier: Object.freeze({ step: 0.05, digits: 2 })
});

const MINUS_ICON = '<svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none"><path d="M10.416 25H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
const PLUS_ICON = '<svg aria-hidden="true" width="36" height="36" viewBox="0 0 50 50" fill="none"><path d="M24.9993 10.4165V39.5832M10.416 24.9998H39.5827" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';

function multiplierCard({ key, label, description, unit = '', step }) {
    return `
        <section class="border border-[#c9c9c9] border-solid flex flex-col gap-[20px] items-center px-[60px] py-[20px] w-[590px]">
            <p id="${key}-label" class="font-['Inter:Regular',sans-serif] font-normal leading-[1.2] text-[var(--text-primary)] text-[30px]" data-i18n-key="${label}">${label}</p>
            <div class="flex gap-[20px] h-[72px] items-center justify-center w-full">
                <button type="button" data-adjust="${key}" data-delta="-${step}" aria-label="Decrease ${label.toLowerCase()}" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center">${MINUS_ICON}</button>
                <div class="text-center text-[var(--text-primary)] text-[24px] font-bold flex items-center justify-center w-[130px]">
                    <input type="text" inputmode="decimal" data-setting="${key}" aria-labelledby="${key}-label" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full" min="0">
                    ${unit ? `<span class="ml-2 text-nowrap" aria-hidden="true">${unit}</span>` : ''}
                </div>
                <button type="button" data-adjust="${key}" data-delta="${step}" aria-label="Increase ${label.toLowerCase()}" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center">${PLUS_ICON}</button>
            </div>
            <p class="font-['Inter:Regular',sans-serif] font-normal leading-[1.4] text-[var(--text-primary)] text-[24px] w-full text-center">${description}</p>
        </section>`;
}

function render(container) {
    container.innerHTML = `
        <div class="flex flex-col gap-[60px] items-start w-full">
            <div class="font-['Inter:Semi_Bold',sans-serif] font-semibold text-[var(--text-primary)] text-[36px] text-center w-full">
                <p class="leading-[1.2]" data-i18n-key="Flow Multiplier Settings">Flow Multiplier Settings</p>
            </div>
            <div class="h-0 w-full"><hr class="border-t border-[#c9c9c9] w-full"></div>
            <div class="flex flex-col items-center gap-[30px] w-full">
                ${multiplierCard({
                    key: 'weightFlowMultiplier',
                    label: 'Weight Flow Multiplier',
                    step: 0.1,
                    description: 'Multiplier factor applied to weight flow for projected weight calculation when stopping shots by weight. Default is 1.0. Higher values stop the shot earlier, lower values stop later.'
                })}
                ${multiplierCard({
                    key: 'volumeFlowMultiplier',
                    label: 'Volume Flow Multiplier (s)',
                    unit: 's',
                    step: 0.05,
                    description: 'Multiplier factor (in seconds) applied to machine flow for projected volume calculation when stopping shots by volume. Default is 0.3. This accounts for system lag between stop command and actual flow stop.'
                })}
                <p data-settings-error role="status" class="hidden text-red-500 text-[22px] text-center"></p>
            </div>
        </div>`;
    translatePage();
}

function sync(container, snapshot) {
    Object.entries(FIELDS).forEach(([key, config]) => {
        const input = container.querySelector(`[data-setting="${key}"]`);
        if (input && document.activeElement !== input) {
            input.value = Number(snapshot.rea[key]).toFixed(config.digits).replace(/0+$/, '').replace(/\.$/, '');
        }
    });
    const error = container.querySelector('[data-settings-error]');
    if (error) {
        error.textContent = snapshot.error || '';
        error.classList.toggle('hidden', !snapshot.error);
    }
}

export async function mountSettingsCategory(context) {
    if (context.category !== 'flowmultiplier' && context.category !== 'quickadjustments') {
        const legacy = await import('./legacy-category.js');
        return legacy.mountSettingsCategory(context);
    }

    const { container } = context;
    render(container);
    sync(container, getSnapshot());

    const onClick = event => {
        const button = event.target.closest('[data-adjust]');
        if (!button || !container.contains(button)) return;
        const key = button.dataset.adjust;
        const config = FIELDS[key];
        const current = Number(getSnapshot().rea[key]);
        const next = Math.max(0, current + Number(button.dataset.delta));
        updateReaSetting(key, Number(next.toFixed(config.digits)));
        ui.flashPlusMinusButton(button);
    };
    const onChange = event => {
        const key = event.target.dataset.setting;
        if (!FIELDS[key]) return;
        updateReaSetting(key, Math.max(0, Number(event.target.value)));
    };
    container.addEventListener('click', onClick);
    container.addEventListener('change', onChange);
    const unsubscribe = subscribe(snapshot => sync(container, snapshot));

    return () => {
        unsubscribe();
        container.removeEventListener('click', onClick);
        container.removeEventListener('change', onChange);
    };
}
