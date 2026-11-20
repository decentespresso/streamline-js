import { getBeans, getBeanBatches, updateWorkflow } from './api.js';
import { getTranslation } from './i18n.js';
import { selectableBeans, selectableBatches, currentBeanContext } from './bean-selection.js';

/** Select the bean batch; it persists across shots until changed. */
export async function openBeanSelectionModal({ onSaved } = {}) {
    const token = { active: true, generation: 0 };
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-labelledby', 'bean-selection-heading');
    dialog.className = 'rounded-2xl bg-[var(--bgmain-color)] p-6 text-[var(--text-primary)]';
    dialog.innerHTML = `<form method="dialog" class="flex w-[min(92vw,640px)] flex-col gap-5">
      <h2 id="bean-selection-heading" class="text-[26px]">${getTranslation('Select coffee batch for next shot')}</h2>
      <label class="flex flex-col gap-2"><span>${getTranslation('Coffee')}</span><select name="bean" class="rounded-lg p-3 text-black" required><option value="">${getTranslation('Choose coffee')}</option></select></label>
      <label class="flex flex-col gap-2"><span>${getTranslation('Batch')}</span><select name="batch" class="rounded-lg p-3 text-black" required disabled><option value="">${getTranslation('Choose batch')}</option></select></label>
      <p data-status aria-live="polite">${getTranslation('Loading coffee catalog…')}</p>
      <div class="flex justify-end gap-3"><button value="cancel" formnovalidate class="rounded-lg p-3">${getTranslation('Cancel')}</button><button type="button" data-save class="rounded-lg p-3" disabled>${getTranslation('Use for next shot')}</button></div>
    </form>`;
    document.body.appendChild(dialog);
    const form = dialog.querySelector('form');
    const beanSelect = form.elements.bean;
    const batchSelect = form.elements.batch;
    const status = dialog.querySelector('[data-status]');
    const save = dialog.querySelector('[data-save]');
    let beans = [];
    let batches = [];
    const onPageHide = () => cleanup();
    const cleanup = () => { token.active = false; token.generation += 1; window.removeEventListener('pagehide', onPageHide); dialog.remove(); };
    dialog.addEventListener('close', cleanup, { once: true });
    window.addEventListener('pagehide', onPageHide, { once: true });
    const renderBatches = () => {
        const generation = ++token.generation;
        batchSelect.replaceChildren(new Option(getTranslation('Choose batch'), ''));
        batches = [];
        batchSelect.disabled = true;
        save.disabled = true;
        const bean = beans.find(item => String(item.id) === beanSelect.value);
        if (!bean) return;
        getBeanBatches(bean.id, false).then(values => {
            if (!token.active || generation !== token.generation) return;
            batches = selectableBatches(values);
            for (const batch of batches) {
                const option = new Option(batch.name || batch.roastDate || batch.id, batch.id);
                option.textContent = [batch.name, batch.roastLevel, batch.roastDate].filter(Boolean).join(' · ') || batch.id;
                batchSelect.append(option);
            }
            batchSelect.disabled = batches.length === 0;
            status.textContent = batches.length ? getTranslation('Choose a batch') : getTranslation('No active batches found');
        }).catch(() => { if (token.active && generation === token.generation) status.textContent = getTranslation('Could not load batches'); });
    };
    beanSelect.addEventListener('change', renderBatches);
    batchSelect.addEventListener('change', () => { save.disabled = !batchSelect.value; });
    save.addEventListener('click', async () => {
        const bean = beans.find(item => String(item.id) === beanSelect.value);
        const batch = batches.find(item => String(item.id) === batchSelect.value);
        const context = currentBeanContext(bean, batch);
        if (!context) return;
        save.disabled = true;
        beanSelect.disabled = true;
        batchSelect.disabled = true;
        status.textContent = getTranslation('Saving coffee for next shot…');
        try {
            await updateWorkflow({ context }, 'beans.select');
            if (token.active) { onSaved?.(context); dialog.close(); }
        } catch (_) { if (token.active) { save.disabled = false; beanSelect.disabled = false; batchSelect.disabled = false; status.textContent = getTranslation('Could not save coffee for next shot'); } }
    });
    dialog.showModal();
    try {
        beans = selectableBeans(await getBeans(false));
        if (!token.active) return dialog;
        for (const bean of beans) {
            const option = new Option(bean.name || bean.id, bean.id);
            option.textContent = [bean.name, bean.roaster, bean.species].filter(Boolean).join(' · ') || bean.id;
            beanSelect.append(option);
        }
        status.textContent = beans.length ? getTranslation('Choose coffee') : getTranslation('No active coffee found');
    } catch (_) {
        if (!token.active) return dialog;
        status.textContent = getTranslation('Could not load coffee catalog');
    }
    return dialog;
}
