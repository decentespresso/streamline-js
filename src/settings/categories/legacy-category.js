import { getPendingReaChanges } from '../settings-data.js';

export async function mountSettingsCategory(context) {
    context.activateLegacy();
    const { cleanupSettings, initializeSettings } = await import('../settings.js');
    await initializeSettings({
        initialMainCategory: context.mainCategory,
        initialCategory: context.category,
        initialReaChanges: getPendingReaChanges(),
        revealTerm: context.revealTerm,
        pendingCategories: context.pendingCategories
    });
    return cleanupSettings;
}
