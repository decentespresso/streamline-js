export const SCREENSAVER_CLOCK_FORMATS = [
    { value: 'locale', label: 'Device default' },
    { value: '12', label: '12:00 PM' },
    { value: '24', label: '24:00' },
];

export const SCREENSAVER_DATE_FORMATS = [
    { value: 'long', label: 'Weekday, month day' },
    { value: 'dmy', label: 'DD/MM/YYYY' },
    { value: 'mdy', label: 'MM/DD/YYYY' },
    { value: 'ymd', label: 'YYYY-MM-DD' },
    { value: 'none', label: 'Hide date' },
];

export const SCREENSAVER_CLOCK_POSITIONS = [
    { value: 'top-left', label: 'Top left' },
    { value: 'top-center', label: 'Top center' },
    { value: 'top-right', label: 'Top right' },
    { value: 'bottom-left', label: 'Bottom left' },
    { value: 'bottom-center', label: 'Bottom center' },
    { value: 'bottom-right', label: 'Bottom right' },
];

export function resolveScreensaverClockFormat(value) {
    return SCREENSAVER_CLOCK_FORMATS.some(option => option.value === value) ? value : 'locale';
}

export function resolveScreensaverClockPosition(value) {
    return SCREENSAVER_CLOCK_POSITIONS.some(option => option.value === value) ? value : 'bottom-center';
}

export function formatScreensaverClockTime(date, format, locales = []) {
    const resolved = resolveScreensaverClockFormat(format);
    const options = { hour: '2-digit', minute: '2-digit' };
    // h23 keeps midnight at 00:00 even in locales whose 24-hour default is h24.
    if (resolved !== 'locale') options.hourCycle = resolved === '24' ? 'h23' : 'h12';
    return date.toLocaleTimeString(locales, options);
}

export function screensaverClockPositionStyle(position) {
    const [vertical, horizontal] = resolveScreensaverClockPosition(position).split('-');
    return {
        top: vertical === 'top' ? '8%' : 'auto',
        bottom: vertical === 'bottom' ? '8%' : 'auto',
        left: horizontal === 'center' ? '0px' : '5%',
        right: horizontal === 'center' ? '0px' : '5%',
        alignItems: horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center',
        textAlign: horizontal,
    };
}

export function resolveScreensaverDateFormat(value) {
    return SCREENSAVER_DATE_FORMATS.some(option => option.value === value) ? value : 'long';
}

// '' for 'none' so the caller can hide the line.
export function formatScreensaverClockDate(date, format, locales = []) {
    const resolved = resolveScreensaverDateFormat(format);
    if (resolved === 'none') return '';
    if (resolved === 'long') return date.toLocaleDateString(locales, { weekday: 'long', month: 'long', day: 'numeric' });
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = String(date.getFullYear());
    return { dmy: `${dd}/${mm}/${yyyy}`, mdy: `${mm}/${dd}/${yyyy}`, ymd: `${yyyy}-${mm}-${dd}` }[resolved];
}
