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
        <section class="grid grid-cols-[1fr_auto] items-center gap-x-[24px] gap-y-[30px] w-full py-[60px] first:pt-0 last:pb-0">
            <p id="${key}-label" class="font-semibold leading-[1.2] text-[var(--action-label)] text-[30px]" data-i18n-key="${label}">${label}</p>
            <div class="flex gap-[20px] items-center justify-end">
                <button type="button" data-adjust="${key}" data-delta="-${step}" aria-label="Decrease ${label.toLowerCase()}" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center">${MINUS_ICON}</button>
                <div class="text-center text-[var(--text-primary)] text-[24px] font-bold flex items-center justify-center w-[130px]">
                    <input type="text" inputmode="decimal" data-setting="${key}" aria-labelledby="${key}-label" class="text-center text-[var(--text-primary)] text-[24px] font-bold bg-transparent border-none w-full" min="0">
                    ${unit ? `<span class="ml-2 text-nowrap" aria-hidden="true">${unit}</span>` : ''}
                </div>
                <button type="button" data-adjust="${key}" data-delta="${step}" aria-label="Increase ${label.toLowerCase()}" class="w-[69px] h-[69px] bg-[var(--button-grey)] rounded-[10px] flex items-center justify-center">${PLUS_ICON}</button>
            </div>
            <p class="font-normal leading-[1.4] text-[var(--text-primary)] text-[24px] w-full col-span-2" data-i18n-key="${description}">${description}</p>
        </section>`;
}

function render(container) {
    container.innerHTML = `
        <div class="flex flex-col gap-[60px] items-start w-full">
            <div class="font-semibold text-[var(--text-primary)] text-[36px] text-center w-full">
                <p class="leading-[1.2]" data-i18n-key="Shot control">Shot control</p>
            </div>
            <div class="h-0 w-full"><hr class="border-t border-[var(--border-primary)] w-full"></div>
            <div class="flex flex-col items-start w-full divide-y divide-[var(--border-primary)]">
                ${multiplierCard({
                    key: 'weightFlowMultiplier',
                    label: 'Weight Look-ahead',
                    step: 0.1,
                    description: 'Used when a scale is connected. Sets how far ahead the shot stop is anticipated, to allow for coffee still dripping after the stop. Default is 1.0. Higher values stop earlier, lower values stop later. Ignored on Bengle, which stops at weight on its own.'
                })}
                ${multiplierCard({
                    key: 'volumeFlowMultiplier',
                    label: 'Volume Look-ahead',
                    step: 0.05,
                    description: 'Used only when no scale is connected. Sets how far ahead the shot stop is anticipated, to allow for water still flowing after the stop. Default is 0.3. Higher values stop earlier, lower values stop later.'
                })}
                <p data-settings-error role="status" class="hidden text-red-500 text-[24px] pt-[30px]"></p>
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
