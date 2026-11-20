const STEP_FIELDS = [
    ['name', 'Name', ''],
    ['pump', 'Pump', ''],
    ['pressure', 'Pressure', ' bar'],
    ['flow', 'Flow', ' ml/s'],
    ['seconds', 'Time', ' s'],
    ['volume', 'Volume', ' ml'],
    ['weight', 'Weight', ' g'],
    ['temperature', 'Temperature', ' °C'],
    ['sensor', 'Sensor', ''],
    ['transition', 'transition', ''],
    ['exit', 'Exit', ''],
    ['limiter', 'Limit', ''],
];

const PROFILE_FIELDS = [
    ['target_weight', 'Stop at weight', ' g'],
    ['target_volume', 'Stop at volume', ' ml'],
    ['beverage_type', 'Beverage type', ''],
    ['tank_temperature', 'Tank', ' °C'],
    ['target_volume_count_start', 'Preinfusion ends after', ''],
];

const EXIT_UNITS = { pressure: ' bar', flow: ' ml/s', weight: ' g' };

function formatNumber(value) {
    return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : String(value);
}

function formatValue(field, value, unit) {
    if (value === undefined || value === null || value === '') return 'None';
    if (field === 'exit') {
        if (typeof value !== 'object') return String(value);
        return `${value.type ?? '?'} ${value.condition ?? ''} ${formatNumber(value.value)}${EXIT_UNITS[value.type] ?? ''}`.replace(/\s+/g, ' ');
    }
    if (field === 'limiter') {
        if (typeof value !== 'object' || !Number(value.value)) return 'None';
        return `${formatNumber(value.value)} (range ${formatNumber(value.range)})`;
    }
    return typeof value === 'number' ? `${formatNumber(value)}${unit}` : `${value}${unit}`;
}

const normalize = (field, value) => (field === 'limiter' && !Number(value?.value) ? null : value ?? null);

const same = (field, a, b) => JSON.stringify(normalize(field, a)) === JSON.stringify(normalize(field, b));

export const stepsDiffer = (a, b) => STEP_FIELDS.some(([field]) => !same(field, a?.[field], b?.[field]));

function fieldChanges(fields, current, other) {
    return fields
        .filter(([field]) => !same(field, current?.[field], other?.[field]))
        .map(([field, label, unit]) => ({
            label,
            from: formatValue(field, current?.[field], unit),
            to: formatValue(field, other?.[field], unit),
        }));
}

export function profileChanges(current, other) {
    if (!current || !other) return { steps: [], profile: [] };
    const stepsA = current.steps || [];
    const stepsB = other.steps || [];
    const steps = [];
    for (let i = 0; i < Math.max(stepsA.length, stepsB.length); i++) {
        const a = stepsA[i];
        const b = stepsB[i];
        const name = (b ?? a)?.name || '';
        if (!a) steps.push({ index: i, name, status: 'added', fields: [] });
        else if (!b) steps.push({ index: i, name, status: 'removed', fields: [] });
        else if (stepsDiffer(a, b)) steps.push({ index: i, name, status: 'changed', fields: fieldChanges(STEP_FIELDS, a, b) });
    }
    return { steps, profile: fieldChanges(PROFILE_FIELDS, current, other) };
}
