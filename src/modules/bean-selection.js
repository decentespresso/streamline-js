/** DOM-free selection helpers for the current workflow's coffee batch. */
export function selectableBeans(beans) {
    return Array.isArray(beans) ? beans.filter(bean => bean?.id && bean.archived !== true) : [];
}

export function selectableBatches(batches) {
    return Array.isArray(batches) ? batches.filter(batch => typeof batch?.id === 'string' && batch.id.length > 0 && batch.archived !== true) : [];
}

export function currentBeanContext(bean, batch) {
    if (typeof bean?.id !== 'string' || !bean.id || typeof batch?.id !== 'string' || !batch.id || (batch.beanId != null && String(batch.beanId) !== bean.id)) return null;
    return {
        beanBatchId: String(batch.id),
        coffeeName: String(bean.name || ''),
        coffeeRoaster: String(bean.roaster || ''),
    };
}
