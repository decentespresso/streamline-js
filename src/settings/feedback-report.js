// What a feedback report says about where the problem is. DOM-free so the
// composition can be tested under node.
//
// Every report Decaid files lands on decentespresso/decaid, whichever part of
// the system the user was talking about: POST /api/v1/feedback carries a
// description and a type, and nothing that names a component. A skin bug, an
// app bug and a plugin bug therefore arrive looking identical, and triage has
// to guess from the prose.
//
// The skin owns the description, and Decaid's issue title is its first line, so
// the user's answer can ride along in both: a tag in the title and a line in
// the body. That works against every installed Decaid. Routing the issue to the
// right repository instead would need a component field in Decaid's own
// request schema.

export const FEEDBACK_AREAS = Object.freeze([
    Object.freeze({ value: 'skin', label: 'Streamline skin', sub: 'Screens, tiles, settings' }),
    Object.freeze({ value: 'decaid', label: 'Decaid app', sub: 'Machine, scale, connection' }),
    Object.freeze({ value: 'plugin', label: 'A plugin', sub: 'DYE2, Shot Uploader, others' }),
]);

// The form opens on the skin, which is where the user is standing; a report
// about the app or a plugin is one tap away. Shared with the page so the markup
// and the submit cannot disagree about what was selected.
export const FEEDBACK_DEFAULT_AREA = 'skin';

const TAGS = Object.freeze({ skin: '[Skin]', decaid: '[Decaid]', plugin: '[Plugin]' });

export function isFeedbackArea(area) {
    return FEEDBACK_AREAS.some(a => a.value === area);
}

// The tag that opens the issue title. An unknown area tags nothing rather than
// inventing a component: a mislabelled report is worse than an unlabelled one.
export function areaTitleTag(area) {
    return TAGS[area] || '';
}

// `A plugin` is only an answer with the plugin named, which is the whole point
// of asking -- a plugin report that does not say which plugin tells triage no
// more than no answer at all. Version included where the list knew it.
export function areaDescribed(area, plugin) {
    if (area === 'skin') return plugin?.skinVersion ? `Streamline skin ${plugin.skinVersion}` : 'Streamline skin';
    if (area === 'decaid') return 'Decaid app';
    if (area !== 'plugin') return '';
    if (!plugin?.id) return 'A plugin (not named)';
    return plugin.version ? `Plugin ${plugin.id} ${plugin.version}` : `Plugin ${plugin.id}`;
}

// The description the skin posts. Its first line becomes the issue title (with
// Decaid's own `[Bug Report]` prefix in front), so the tag goes there and the
// area line goes in the body above the user's text.
export function buildFeedbackDescription({ area, title, description = '', plugin = null } = {}) {
    const headline = [areaTitleTag(area), String(title || '').trim()].filter(Boolean).join(' ');
    const described = areaDescribed(area, plugin);
    const lines = [headline];
    if (described) lines.push('', `**Area:** ${described}`);
    const body = String(description || '').trim();
    if (body) lines.push('', body);
    return lines.join('\n');
}
