import { init as initProfileManager, unhideProfile,availableProfiles, assignProfile, setActiveProfile, getActiveProfileId, translateProfileTitle, deleteOrHideProfile, loadAssignments, handleProfileUpload , verifyProfileChange, renameProfile, applyWorkflowToMainPageUI, withSavedBrewTemp, duplicateProfileAsDraft, deleteProfileDraft } from './profileManager.js';
import { resolveProfileKeyByTitle } from './active-profile.js';
import { openDB } from './idb.js';
import { logger } from './logger.js';
import { initResizablePanels, showToast, initFullscreenHandler, updateProfileName, setupPressAndHold } from './ui.js';
import { sendProfile, getWorkflow, updateWorkflow, callPluginEndpoint, getPluginSettings, setPluginSettings, verifyVisualizerCredentials, deleteProfile, updateProfileVisibility, API_BASE_URL } from './api.js';
import { initChart, plotProfile } from './chart.js';
import { translatePage, getTranslation } from './i18n.js';
import { loadPage } from './router.js';
import { openContextMenu, closeContextMenu } from './context-menu.js';

// Visualizer credentials storage
let cachedVisualizerCredentials = null;
const initializedProfileRoots = new WeakSet();
// True when the pre-selected profile is just "the first row" rather than the
// profile the machine actually has loaded -- see initializeProfileSelector.
let selectionIsFallback = false;
let profilesUpdatedListenerInstalled = false;

function handleProfilesUpdated() {
    logger.info('Received profiles-updated event, re-rendering profile list.');
    renderProfiles();
}

function ensureProfilesUpdatedListener() {
    if (profilesUpdatedListenerInstalled) return;
    document.addEventListener('profiles-updated', handleProfilesUpdated);
    profilesUpdatedListenerInstalled = true;
}

/**
 * Check if Visualizer credentials are configured
 * @returns {Promise<{configured: boolean, username: string|null, passwordSet: boolean}>}
 */
async function checkVisualizerCredentials() {
    if (cachedVisualizerCredentials) {
        return cachedVisualizerCredentials;
    }
    
    try {
        const settings = await getPluginSettings('visualizer.reaplugin');
        const enabled = settings?.Enabled !== false; // Default to enabled
        const username = settings?.Username;
        // Secure settings come back as { isSet } state, never plaintext (decaid #588).
        const password = settings?.Password;
        const passwordSet = password == null ? false
            : typeof password === 'object' ? password.isSet === true
            : !!password; // legacy cleartext from older decaid

        cachedVisualizerCredentials = {
            configured: enabled && !!(username && passwordSet),
            enabled: enabled,
            username: username || null,
            passwordSet
        };
        
        return cachedVisualizerCredentials;
    } catch (error) {
        logger.error('Error checking Visualizer credentials:', error);
        return { configured: false, enabled: true, username: null, passwordSet: false };
    }
}

/**
 * Show the add profile options modal
 */
function showAddProfileModal() {
    const modal = document.getElementById('add-profile-modal');
    if (modal) {
        modal.showModal();
    }
}

/**
 * Close the add profile options modal
 */
function closeAddProfileModal() {
    const modal = document.getElementById('add-profile-modal');
    if (modal) {
        modal.close();
    }
}

/**
 * Handle upload local file button click
 */
function handleUploadLocalClick() {
    closeAddProfileModal();
    const fileInput = document.getElementById('profile-upload-input');
    if (fileInput) {
        fileInput.click();
    }
}

/**
 * Show the share code input modal
 */
async function handleImportShareCodeClick() {
    closeAddProfileModal();
    
    // Check credentials first
    const creds = await checkVisualizerCredentials();
    
    if (!creds.enabled) {
        showToast('Visualizer plugin is disabled. Enable it in Settings.', 4000, 'warning');
        return;
    }
    
    if (!creds.configured) {
        // Show login required modal
        showLoginRequiredModal();
        return;
    }
    
    // Show share code input modal
    const modal = document.getElementById('share-code-modal');
    if (modal) {
        const input = document.getElementById('share-code-input');
        const errorMsg = document.getElementById('share-code-error');
        const importBtn = document.getElementById('share-code-import-btn');
        
        // Clear previous input and error
        if (input) input.value = '';
        if (errorMsg) {
            errorMsg.textContent = '';
            errorMsg.classList.add('hidden');
        }
        if (importBtn) importBtn.disabled = false;
        
        modal.showModal();
        
        // Focus the input after modal opens
        setTimeout(() => {
            if (input) input.focus();
        }, 100);
    }
}

/**
 * Show the login required modal
 */
function showLoginRequiredModal() {
    const modal = document.getElementById('login-required-modal');
    if (modal) {
        modal.showModal();
    }
}

/**
 * Close the share code modal
 */
function closeShareCodeModal() {
    const modal = document.getElementById('share-code-modal');
    if (modal) {
        modal.close();
    }
}

/**
 * Close the login required modal
 */
function closeLoginRequiredModal() {
    const modal = document.getElementById('login-required-modal');
    if (modal) {
        modal.close();
    }
}

/**
 * Handle share code import
 */
async function handleShareCodeImport() {
    const input = document.getElementById('share-code-input');
    const errorMsg = document.getElementById('share-code-error');
    const importBtn = document.getElementById('share-code-import-btn');
    
    if (!input) return;
    
    const shareCode = input.value.trim();
    
    // Validate input
    if (!shareCode || shareCode.length !== 4) {
        if (errorMsg) {
            errorMsg.textContent = 'Please enter a valid 4-digit share code';
            errorMsg.classList.remove('hidden');
        }
        return;
    }
    
    // Disable button during import
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.textContent = 'Importing...';
    }
    
    try {
        logger.info(`Importing profile from share code: ${shareCode}`);
        
        // Call the plugin import endpoint
        const result = await callPluginEndpoint(
            'visualizer.reaplugin',
            'import',
            { shareCode: shareCode }
        );
        
        logger.info('Profile import result:', result);
        
        if (result.success) {
            // Check for duplicate profile title and handle it
            const importedTitle = result.profileTitle || 'Imported Profile';
            
            // Check if a profile with the same title already exists in current profiles
            const existingProfileKey = Object.keys(availableProfiles).find(key => {
                const profile = availableProfiles[key];
                return profile && profile.profile && profile.profile.title === importedTitle;
            });
            
            let finalTitle = importedTitle;
            let profileIdToRename = result.profileId;
            
            if (existingProfileKey && profileIdToRename) {
                // Profile with same title exists - rename with suffix
                let counter = 1;
                let newTitle = `${importedTitle} (${counter})`;
                
                // Keep incrementing until we find a unique name
                while (Object.values(availableProfiles).some(p => p.profile.title === newTitle)) {
                    counter++;
                    newTitle = `${importedTitle} (${counter})`;
                }
                finalTitle = newTitle;
                
                // Rename the newly imported profile
                try {
                    await renameProfile(profileIdToRename, finalTitle);
                    logger.info(`Renamed duplicate profile to: ${finalTitle}`);
                } catch (renameError) {
                    logger.warn('Could not rename duplicate profile:', renameError);
                }
            }
            
            closeShareCodeModal();
            showToast(`Profile "${finalTitle}" imported successfully!`, 4000, 'success');
            
            // Reinitialize profile manager to refresh the list
            await initProfileManager();
            
            // Re-render profiles
            renderProfiles();
        } else {
            throw new Error(result.error || 'Import failed');
        }
    } catch (error) {
        logger.error('Failed to import profile from share code:', error);
        
        if (errorMsg) {
            errorMsg.textContent = error.message || 'Failed to import profile';
            errorMsg.classList.remove('hidden');
        }
        
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.textContent = getTranslation('Import');
        }
    }
}

/**
 * Initialize modal event listeners
 */
function initModals() {
    // Add profile modal buttons
    const uploadLocalBtn = document.getElementById('upload-local-btn');
    if (uploadLocalBtn) {
        uploadLocalBtn.addEventListener('click', handleUploadLocalClick);
    }
    
    const importShareCodeBtn = document.getElementById('import-share-code-btn');
    if (importShareCodeBtn) {
        importShareCodeBtn.addEventListener('click', handleImportShareCodeClick);
    }
    
    const addProfileModalClose = document.getElementById('add-profile-modal-close');
    if (addProfileModalClose) {
        addProfileModalClose.addEventListener('click', closeAddProfileModal);
    }
    
    // Share code modal buttons
    const shareCodeCancelBtn = document.getElementById('share-code-cancel-btn');
    if (shareCodeCancelBtn) {
        shareCodeCancelBtn.addEventListener('click', closeShareCodeModal);
    }
    
    const shareCodeImportBtn = document.getElementById('share-code-import-btn');
    if (shareCodeImportBtn) {
        shareCodeImportBtn.addEventListener('click', handleShareCodeImport);
    }
    
    const shareCodeModalClose = document.getElementById('share-code-modal-close');
    if (shareCodeModalClose) {
        shareCodeModalClose.addEventListener('click', closeShareCodeModal);
    }
    
    // Share code input - Enter key support
    const shareCodeInput = document.getElementById('share-code-input');
    if (shareCodeInput) {
        shareCodeInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleShareCodeImport();
            }
        });
        
        // Limit to 4 characters (alphanumeric)
        shareCodeInput.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4);
            
            // Enable/disable import button based on length
            const importBtn = document.getElementById('share-code-import-btn');
            if (importBtn) {
                importBtn.disabled = e.target.value.length !== 4;
            }
        });
    }
    
    // Login required modal buttons
    const loginModalCancelBtn = document.getElementById('login-modal-cancel-btn');
    if (loginModalCancelBtn) {
        loginModalCancelBtn.addEventListener('click', closeLoginRequiredModal);
    }
    
    const loginModalGoBtn = document.getElementById('login-modal-go-btn');
    if (loginModalGoBtn) {
        loginModalGoBtn.addEventListener('click', () => {
            closeLoginRequiredModal();
            // Navigate to settings page
            loadPage('src/settings/settings.html');
        });
    }
    
    const loginRequiredModalClose = document.getElementById('login-required-modal-close');
    if (loginRequiredModalClose) {
        loginRequiredModalClose.addEventListener('click', closeLoginRequiredModal);
    }
}

let selectedProfileKey = null;
let isShowingHidden = false; // State to track if hidden profiles should be shown
let isSearching = false; // State to track if search mode is active
const LONG_PRESS_DURATION = 400; // ms
const FAV_COUNT = 5;
let favoriteButtons = [];

// Suppress browser-default text selection, context menu, tap-highlight, drag, and
// iOS callout across an entire subtree. Inputs/textareas/contenteditable are
// exempted so typing in the search field still works.
function suppressBrowserActions(root) {
    if (!root || root.dataset.browserActionsSuppressed === '1') return;
    root.dataset.browserActionsSuppressed = '1';

    root.style.userSelect = 'none';
    root.style.webkitUserSelect = 'none';
    root.style.webkitTouchCallout = 'none';
    root.style.webkitTapHighlightColor = 'transparent';
    root.style.touchAction = 'manipulation';

    const isTypingTarget = (el) =>
        !!el && !!el.closest && !!el.closest('input, textarea, [contenteditable="true"]');

    const block = (e) => {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
    };

    root.addEventListener('contextmenu', block);
    root.addEventListener('selectstart', block);
    root.addEventListener('dragstart', block);
}

function getEyeIconSVG(strokeColor) {
    return `<svg aria-hidden="true" class="w-[36px] h-[36px]" viewBox="0 0 66 66" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 33C5.5 33 13.75 13.75 33 13.75C52.25 13.75 60.5 33 60.5 33C60.5 33 52.25 52.25 33 52.25C13.75 52.25 5.5 33 5.5 33Z" stroke="${strokeColor}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 41.25C37.5563 41.25 41.25 37.5563 41.25 33C41.25 28.4437 37.5563 24.75 33 24.75C28.4437 24.75 24.75 28.4437 24.75 33C24.75 37.5563 28.4437 41.25 33 41.25Z" stroke="${strokeColor}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}


// Copied from profileManager.js to keep that module's interface clean
// async function verifyProfileChange(sentProfileTitle, retries = 5, delay = 300) {
//     if (retries <= 0) {
//         logger.error(`Profile verification failed after multiple retries. Sent '${sentProfileTitle}'.`);
//         return false;
//     }

//     const currentWorkflow = await getWorkflow();
//     const activeProfileTitle = currentWorkflow?.profile?.title;

//     if (sentProfileTitle === activeProfileTitle) {
//         logger.info('Verification successful. Active profile matches sent profile.');
//         return true;
//     } else {
//         logger.warn(`Verification attempt failed. Retrying... (${retries - 1} left). Sent: '${sentProfileTitle}', Active: '${activeProfileTitle}'`);
//         await new Promise(resolve => setTimeout(resolve, delay));
//         return verifyProfileChange(sentProfileTitle, retries - 1, delay);
//     }
// }

let isConfirmingProfile = false;

async function handleConfirm() {
    if (isConfirmingProfile) return;

    let sentworkflow = {};
    const profileKey = selectedProfileKey;
    if (!profileKey) {
        alert('Please select a profile first.');
        return;
    }

    const profileRecord = availableProfiles[profileKey];
    if (!profileRecord || !profileRecord.profile) {
        logger.error(`Selected profile with key ${profileKey} not found!`);
        alert('An error occurred: selected profile not found.');
        showToast(`An error occurred: selected profile not found.`, 3000, 'alert');
        return;
    }
    const profile = profileRecord.profile;
    const meta = profileRecord.metadata || {};
    const savedGrind = meta.grinderSetting ?? null;
    const grindContext = savedGrind != null ? { grinderSetting: savedGrind } : { grinderSetting: null };
    const effectiveDose  = meta.targetDoseWeight  ?? (profile.dose_weight   || 18);
    const effectiveYield = meta.targetYield        ?? parseFloat(profile.target_weight);
    // Same saved-override fold the favourite buttons do (profileManager
    // applyProfileToMachine) -- this page is the other way into a profile
    // switch, and without it a brew-temp edit is lost coming through here.
    const profileToSend = withSavedBrewTemp(profile, meta);

    logger.info(`Confirming and sending profile: ${profile.title}`);
    // A rejected favourite assignment has already put its error toast on screen;
    // the 'Profile Set' toast below would overwrite it a few hundred ms later,
    // so the user never gets to read why the assignment did not happen.
    let assignWasRejected = false;
    isConfirmingProfile = true;
    try {
        // Check if there's a pending assignment from a long press on the main page
        const pendingAssignmentIndex = sessionStorage.getItem('pendingAssignmentIndex');

        if (pendingAssignmentIndex !== null) {
            const parsedIndex = parseInt(pendingAssignmentIndex);
            if (parsedIndex < 0 || parsedIndex >= FAV_COUNT) {
                logger.error(`Invalid pendingAssignmentIndex ${parsedIndex} from sessionStorage - must be between 0 and ${FAV_COUNT - 1}. Skipping assignment.`);
                sessionStorage.removeItem('pendingAssignmentIndex');
                showToast('Invalid favorite button. Please try again.', 3000, 'error');
            } else {
                // Assign the profile to the specific favorite button
                const assignResult = await assignProfile(parsedIndex, profileKey);
                assignWasRejected = assignResult === 'rejected';

                // Clear the pending assignment
                sessionStorage.removeItem('pendingAssignmentIndex');

                // Show a success message — but not when the assign was rejected or
                // was a no-op, or this lands on top of the error toast a second later.
                if (assignResult === 'assigned') {
                    setTimeout(() => showToast(`${getTranslation('Assign to favourite {n}').replace('{n}', parsedIndex + 1)}: ${translateProfileTitle(profile.title)}`, 3000, 'success'), 1000  );
                }
            }
        }

        // Update workflow with profile's target weight before sending the profile
        // This ensures that the target weight from the profile is applied to the workflow
        if (profile.target_weight) {
            const workflowUpdate = {
                profile: profileToSend,
                context: {
                    targetDoseWeight: effectiveDose,
                    targetYield: effectiveYield,
                    ...grindContext
                }
            };

            sentworkflow = await updateWorkflow(workflowUpdate);
        } else {
            const displayYield = isNaN(effectiveYield) ? 0 : effectiveYield;
            sentworkflow = await updateWorkflow({ profile: profileToSend, context: { targetDoseWeight: effectiveDose, targetYield: displayYield, ...grindContext } });
        }

        const verified = sentworkflow.profile.title === profile.title;
        if (verified) {
            logger.info('Profile sent and verified. Navigating to main page.');
            setActiveProfile(profileKey);
            // Push the freshly-sent workflow to the main-page left column + title
            // so the user lands on a page that already reflects what's on Rea
            // instead of waiting for the next WS snapshot to repaint.
            applyWorkflowToMainPageUI(sentworkflow);
            if (!assignWasRejected) {
                showToast(`Profile Set`, 3000, 'success');
            }
            loadPage('index.html');
        } else {
            alert('Failed to set the profile on the machine. Please try again.');
        }
    } catch (error) {
        logger.error('Failed to send profile:', error);
        alert('An error occurred while sending the profile.');
    } finally {
        isConfirmingProfile = false;
    }
}

function handleCancel() {
    loadPage('index.html');
}


function updateSelectedProfileView(profileItem) {
    console.log('updateSelectedProfileView: Updating selected profile view');
    if (!profileItem) {
        console.log('updateSelectedProfileView: No profile item, clearing view');
        // Clear the view if nothing is selected
        const titleElement = document.getElementById('selected_profile_name');
        if (titleElement) {
            titleElement.textContent = 'No Profile Selected';
        }
        const notesElement = document.getElementById('profile_notes');
        if (notesElement) {
            notesElement.innerHTML = '';
        }
        plotProfile(null); // Clear chart
        selectedProfileKey = null;
        return;
    }

    console.log('updateSelectedProfileView: Profile item found:', profileItem.textContent);
    // Update title — prefer explicit data attr so badge/decoration text doesn't leak in
    const profileTitle = profileItem.dataset.profileTitle
        || translateProfileTitle(availableProfiles[profileItem.dataset.profileKey]?.profile?.title)
        || profileItem.textContent;
    const titleElement = document.getElementById('selected_profile_name');
    if (titleElement) {
        titleElement.textContent = profileTitle;
        console.log('updateSelectedProfileView: Updated profile name to', profileTitle);
    }
    selectedProfileKey = profileItem.dataset.profileKey;
    console.log('updateSelectedProfileView: Selected profile key set to', selectedProfileKey);

    const profileRecord = availableProfiles[selectedProfileKey];
    console.log('updateSelectedProfileView: Profile record found:', !!profileRecord);

    if (profileRecord && profileRecord.profile) {
        const profile = profileRecord.profile;
        console.log('updateSelectedProfileView: Updating with profile:', profile.title);
        // Update notes
        const notesElement = document.getElementById('profile_notes');
        if (notesElement) {
            notesElement.innerHTML = `<p>${profile.notes || 'No notes for this profile.'}</p>`;
            console.log('updateSelectedProfileView: Updated profile notes');
        }

        // Update chart
        console.log('updateSelectedProfileView: Calling plotProfile with profile data');
        plotProfile(profile);
    } else {
        console.log('updateSelectedProfileView: Profile record or profile data not found');
    }
}

// ─── Profile Context Menu ────────────────────────────────────────────────────

async function unhideProfileEntry(key) {
    await unhideProfile(key);
}

function showProfileContextMenu(key, profileRecord, anchorEl) {
    const isHidden = profileRecord.visibility === 'hidden';
    const isDraft = profileRecord.isDraft === true;

    async function doHide() {
        if (isDraft) {
            // A draft never reached the server — nothing to hide there, and
            // deleteOrHideProfile would 404 trying. Just drop the local copy.
            await deleteProfileDraft(key);
        } else {
            await deleteOrHideProfile(key, { forceHide: true });
        }
        const container = document.getElementById('profile-list');
        if (container) {
            const item = container.querySelector(`[data-profile-key="${key}"]`);
            if (item) item.click(); else updateSelectedProfileView(null);
        }
        if (isDraft) document.dispatchEvent(new CustomEvent('profiles-updated'));
    }

    async function doAssign(slotIndex) {
        try {
            const assignResult = await assignProfile(slotIndex, key);
            const pr = availableProfiles[key];
            if (pr?.profile) {
                const meta = pr.metadata || {};
                const dose     = meta.targetDoseWeight ?? (pr.profile.dose_weight || 18);
                const yieldVal = meta.targetYield ?? parseFloat(pr.profile.target_weight);
                const grind    = meta.grinderSetting ?? null;
                try {
                    await updateWorkflow({ profile: pr.profile, context: { targetDoseWeight: dose, targetYield: isNaN(yieldVal) ? 0 : yieldVal, grinderSetting: grind } });
                    setActiveProfile(key);
                    updateProfileName(pr.profile.title);
                } catch (_) {}
                if (assignResult === 'assigned') {
                    showToast(`${getTranslation('Assign to favourite {n}').replace('{n}', slotIndex + 1)}: ${translateProfileTitle(pr.profile.title)}`, 3000, 'success');
                }
            }
        } catch (e) { logger.warn('assignProfile error:', e.message); }
    }

    const items = [
        ...(!isHidden ? [{ label: getTranslation(isDraft ? 'Delete' : 'Hide'), danger: isDraft, onSelect: doHide }] : []),
        { divider: true },
        ...Array.from({ length: FAV_COUNT }, (_, i) => ({
            label: getTranslation('Assign to favourite {n}').replace('{n}', i + 1),
            onSelect: () => doAssign(i),
        })),
        { divider: true },
        {
            label: getTranslation('Edit'),
            onSelect: () => {
                window.__pendingEditProfile = profileRecord;
                loadPage('src/profiles/profile_editor.html');
            },
        },
        {
            label: getTranslation('Duplicate'),
            onSelect: async () => {
                try {
                    const draft = await duplicateProfileAsDraft(key);
                    document.dispatchEvent(new CustomEvent('profiles-updated'));
                    showToast(`${getTranslation('Duplicated')}: ${translateProfileTitle(draft.profile.title)}`, 3000, 'success');
                } catch (e) {
                    logger.warn('Duplicate profile failed:', e);
                    showToast(getTranslation('Duplicate failed'), 3000, 'error');
                }
            },
        },
    ];

    openContextMenu(anchorEl, items);
}

// Key of the profile the machine is currently loaded with, so opening the
// selector lands on it. activeProfileId is only synced when that profile also
// sits on a favorite button (app.js), so fall back to the title rendered in
// #profile-name — the router hides #main-page rather than removing it, so the
// heading is still readable from here.
function findActiveProfileKey() {
    const id = getActiveProfileId();
    if (id) return id;
    const shownTitle = document.getElementById('profile-name')?.textContent.trim();
    if (!shownTitle) return null;
    return Object.keys(availableProfiles).find(
        key => translateProfileTitle(availableProfiles[key]?.profile?.title ?? '') === shownTitle
    ) ?? null;
}

function renderProfiles() {
    console.log('renderProfiles: Starting to render profiles, isShowingHidden =', isShowingHidden);
    logger.info('Profile Editor: Rendering profiles...');
    try {
        const container = document.getElementById('profile-list');
        if (!container) {
            logger.error('Profile Editor: Profile list container not found.');
            console.error('renderProfiles: Profile list container not found');
            return;
        }
        container.innerHTML = ''; // Clear static content
        console.log('renderProfiles: Container cleared');

        const profileEntries = Object.entries(availableProfiles);
        console.log('renderProfiles: Available profiles count:', profileEntries.length);

        const sortedProfiles = profileEntries.sort(([, a], [, b]) => {
            if (a.profile && a.profile.title && b.profile && b.profile.title) {
                return translateProfileTitle(a.profile.title).localeCompare(translateProfileTitle(b.profile.title));
            }
            return 0;
        });

        if (sortedProfiles.length === 0) {
            console.log('renderProfiles: No profiles to render');
            container.textContent = 'No profiles found.';
            updateSelectedProfileView(null); // Clear right panel
            return;
        }

        let visibleProfileCount = 0;

        const renderSectionHeader = (label) => {
            const h = document.createElement('div');
            h.className = 'px-3 pt-4 pb-1 text-[16px] uppercase tracking-wider text-[var(--low-contrast-white)] select-none';
            h.textContent = label;
            container.appendChild(h);
        };

        const renderProfileItem = ([key, profileRecord]) => {
            const profile = profileRecord.profile;
            if (!profile) return;

            const isHidden = profileRecord.visibility === 'hidden';
            console.log('renderProfiles: Processing profile', profile.title, 'isHidden:', isHidden);

            if (!isShowingHidden && isHidden) {
                console.log('renderProfiles: Skipping hidden profile', profile.title);
                return;
            }
            visibleProfileCount++;
            console.log('renderProfiles: Adding profile to list', profile.title);

            const displayTitle = translateProfileTitle(profile.title) || 'Untitled Profile';

            const div = document.createElement('div');
            div.className = 'p-3 text-[30px] cursor-pointer flex justify-between items-center no-select';
            div.dataset.profileKey = key;
            div.dataset.profileTitle = displayTitle;
            div.setAttribute('role', 'option');
            div.setAttribute('aria-selected', (key === selectedProfileKey) ? 'true' : 'false');
            div.setAttribute('aria-label', displayTitle);
            div.tabIndex = -1;

            const leftSide = document.createElement('div');
            leftSide.className = 'flex items-baseline gap-2 min-w-0';
            const titleSpan = document.createElement('span');
            titleSpan.textContent = displayTitle;
            leftSide.appendChild(titleSpan);

            // Lineage badge — "from <parent>" when this is a user-edited clone of a default
            const parentRecord = profileRecord.parentId ? availableProfiles[profileRecord.parentId] : null;
            const parentTitle = parentRecord?.profile?.title;
            if (parentTitle) {
                const badge = document.createElement('span');
                badge.className = 'text-[16px] px-2 py-0.5 rounded-full bg-white/15 whitespace-nowrap';
                badge.textContent = `from ${translateProfileTitle(parentTitle)}`;
                leftSide.appendChild(badge);
            }
            div.appendChild(leftSide);

            if (isHidden) {
                div.classList.add('text-[var(--low-contrast-white)]');
                const unhideButton = document.createElement('button');
                unhideButton.className = 'p-1 hover:bg-gray-200 rounded-full';
                unhideButton.title = 'Show this profile';
                unhideButton.setAttribute('aria-label', `Show profile ${displayTitle}`);
                unhideButton.innerHTML = `<svg class="w-6 h-6" aria-hidden="true" viewBox="0 0 66 66" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 33C5.5 33 13.75 13.75 33 13.75C52.25 13.75 60.5 33 60.5 33C60.5 33 52.25 52.25 33 52.25C13.75 52.25 5.5 33 5.5 33Z" stroke="#385A92" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 41.25C37.5563 41.25 41.25 37.5563 41.25 33C41.25 28.4437 37.5563 24.75 33 24.75C28.4437 24.75 24.75 28.4437 24.75 33C24.75 37.5563 28.4437 41.25 33 41.25Z" stroke="#385A92" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

                unhideButton.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    console.log('renderProfiles: Unhide button clicked for profile', key);
                    await unhideProfileEntry(key);
                    renderProfiles();
                });
                unhideButton.addEventListener('pointerdown', (e) => e.stopPropagation());
                div.appendChild(unhideButton);
            } else {
                div.classList.add('text-[var(--text-primary)]');
                if (key === selectedProfileKey) {
                    div.classList.add('bg-[#385a92]', 'text-white', 'rounded-[8px]');
                }
            }

            const selectItem = () => {
                console.log('renderProfiles: Profile item clicked:', profile.title);
                const clickedItem = div;

                const allItems = clickedItem.parentElement.querySelectorAll('[data-profile-key]');
                for(const item of allItems) {
                    item.classList.remove('bg-[#385a92]', 'text-white', 'rounded-[8px]', 'bg-gray-200', 'text-black');
                    item.setAttribute('aria-selected', 'false');
                    const itemKey = item.dataset.profileKey;
                    if (itemKey && availableProfiles[itemKey] && availableProfiles[itemKey].visibility === 'hidden') {
                        item.classList.add('text-[var(--low-contrast-white)]');
                    } else {
                        item.classList.add('text-[var(--text-primary)]');
                    }
                }

                if (isHidden) {
                    clickedItem.classList.add('bg-gray-200', 'rounded-[8px]');
                    clickedItem.classList.remove('text-white');

                } else {
                    clickedItem.classList.add('bg-[#385a92]', 'text-white', 'rounded-[8px]');
                    clickedItem.classList.remove('text-[#121212]');
                }

                clickedItem.setAttribute('aria-selected', 'true');
                updateSelectedProfileView(clickedItem);
            };

            const openMenu = () => {
                selectItem();
                showProfileContextMenu(key, profileRecord, div);
            };

            div.setAttribute('aria-haspopup', 'menu');
            setupPressAndHold(div, selectItem, openMenu, { touchAction: 'pan-y' });

            // Long press is the only affordance now that the overflow button is
            // gone, and it needs a pointer held down — which a mouse user has no
            // reason to try. The root suppresses the browser's own menu (see
            // suppressTouchDefaults), so right-click is free to open ours.
            div.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                openMenu();
            });

            container.appendChild(div);
        };

        // Partition: built-in defaults vs user-owned (kv records, includes clones)
        const defaultsList = sortedProfiles.filter(([, r]) => r.isDefault === true);
        const yoursList = sortedProfiles.filter(([, r]) => r.isDefault !== true);

        if (yoursList.length > 0) {
            renderSectionHeader('Your Profiles');
            yoursList.forEach(renderProfileItem);
        }
        if (defaultsList.length > 0) {
            renderSectionHeader('Built-In Profiles');
            defaultsList.forEach(renderProfileItem);
        }

        console.log('renderProfiles: Total visible profiles:', visibleProfileCount);
        if (visibleProfileCount > 0 && !selectedProfileKey) {
            // Honor a return-from-editor hint, then the loaded profile, before
            // falling back to first item.
            const lastEditedKey = sessionStorage.getItem('lastEditedProfileKey');
            let initialItem = null;
            if (lastEditedKey) {
                initialItem = container.querySelector(`[data-profile-key="${CSS.escape(lastEditedKey)}"]`);
                sessionStorage.removeItem('lastEditedProfileKey');
            }
            if (!initialItem) {
                const activeKey = findActiveProfileKey();
                if (activeKey) initialItem = container.querySelector(`[data-profile-key="${CSS.escape(activeKey)}"]`);
            }
            selectionIsFallback = !initialItem;
            if (!initialItem) initialItem = container.querySelector('[data-profile-key]');
            if (initialItem) {
                initialItem.classList.add('bg-[#385a92]', 'text-white', 'rounded-[8px]');
                initialItem.setAttribute('aria-selected', 'true');
                updateSelectedProfileView(initialItem);
                // The list is taller than the pane and sorted alphabetically, so the
                // pre-selected item is usually out of view. 'nearest' leaves an
                // already-visible item alone instead of yanking the list.
                initialItem.scrollIntoView({ block: 'nearest' });
            }
        }

        logger.info(`Profile Editor: Rendered ${visibleProfileCount} profiles.`);

    } catch (error) {
        console.error('renderProfiles: Error rendering profiles:', error);
        logger.error('Profile Editor: Failed to render profiles.', error);
        const container = document.getElementById('profile-list');
        if(container) {
            container.innerHTML = '<div class="p-3 text-error">Error loading profiles. See console for details.</div>';
        }
    }
}

async function initFavoriteButtons() {
    await loadAssignments();

    favoriteButtons = [];

    for (let i = 0; i < FAV_COUNT; i++) {
        const button = document.getElementById(`assign-fav-btn-${i}`);
        if (button) {
            favoriteButtons.push(button);
        }
    }

    favoriteButtons.forEach((button, index) => {
        let pressTimer = null;

        // Browser long-press defaults (text selection, context menu, iOS callout,
        // tap-highlight, drag) are suppressed at the page root via
        // suppressBrowserActions(). No per-button wiring needed here.

        const startPress = async () => {
            if (index < 0 || index >= FAV_COUNT) {
                logger.error(`Invalid button index ${index} in initFavoriteButtons startPress - must be between 0 and ${FAV_COUNT - 1}`);
                return;
            }
            clearTimeout(pressTimer);
            showToast(`Hold to assign profile.`, 1500, 'info');
            pressTimer = setTimeout(async () => {
                if (selectedProfileKey) {
                    let assignResult = 'unchanged';
                    try {
                        assignResult = await assignProfile(index, selectedProfileKey);
                    } catch (e) {
                        logger.warn('Caught expected error from assignProfile modal close:', e.message);
                    }
                    const profileRecord = availableProfiles[selectedProfileKey];
                    if (profileRecord && profileRecord.profile) {
                        const profile = profileRecord.profile;
                        const meta = profileRecord.metadata || {};
                        const savedGrind = meta.grinderSetting ?? null;
                        const grindContext = savedGrind != null ? { grinderSetting: savedGrind } : { grinderSetting: null };
                        const effectiveDose = meta.targetDoseWeight ?? (profile.dose_weight || 18);
                        const effectiveYield = meta.targetYield ?? parseFloat(profile.target_weight);
                        const displayYield = isNaN(effectiveYield) ? 0 : effectiveYield;
                        try {
                            await updateWorkflow({
                                profile,
                                context: { targetDoseWeight: effectiveDose, targetYield: displayYield, ...grindContext }
                            });
                            setActiveProfile(selectedProfileKey);
                            updateProfileName(profile.title);
                        } catch (e) {
                            logger.error('Failed to send profile to machine after assignment:', e);
                        }
                        // Only on a genuinely new assignment — a rejected assign has
                        // already shown its own error toast.
                        if (assignResult === 'assigned') {
                            showToast(`${getTranslation('Assign to favourite {n}').replace('{n}', index + 1)}: ${translateProfileTitle(profile.title)}`, 3000, 'success');
                        }
                    }
                } else {
                    showToast('Please select a profile from the list to assign it.', 3000, 'error');
                }
                pressTimer = null;
            }, LONG_PRESS_DURATION);
        };

        const cancelPress = () => {
            clearTimeout(pressTimer);
        };

        button.addEventListener('mousedown', startPress);
        button.addEventListener('mouseup', cancelPress);
        button.addEventListener('mouseleave', cancelPress);
        button.addEventListener('touchstart', startPress, { passive: true });
        button.addEventListener('touchend', cancelPress);
    });
}

function initDeleteButton() {
    console.log('initDeleteButton: Starting initialization');
    const deleteButton = document.getElementById('delete_profile');
    console.log('initDeleteButton: deleteButton found:', !!deleteButton);
    if (!deleteButton) {
        console.error('initDeleteButton: delete_profile button not found');
        return;
    }

    // Remove any existing click listeners to prevent duplicates
    // Create a new button element to clear all event listeners
    const newDeleteButton = deleteButton.cloneNode(true);
    deleteButton.parentNode.replaceChild(newDeleteButton, deleteButton);

    // Use the cloned button (which has no event listeners)
    const button = newDeleteButton;

    button.addEventListener('click', async () => {
        console.log('initDeleteButton: Delete button clicked');
        if (!selectedProfileKey) {
            console.log('initDeleteButton: No profile selected');
            showToast("No profile selected to delete.", 3000, 'error');
            return;
        }

        const profileRecord = availableProfiles[selectedProfileKey];
        if (!profileRecord || !profileRecord.profile) {
            console.log('initDeleteButton: Profile record or data missing');
            showToast("Cannot delete profile: data missing.", 3000, 'error');
            return;
        }
        const profile = profileRecord.profile;
        const isDefault = profileRecord.isDefault;
        const displayTitle = translateProfileTitle(profile.title);
        const confirmationText = isDefault
            ? `Are you sure you want to hide '${displayTitle}'?`
            : `Are you sure you want to permanently delete '${displayTitle}'?`;

        console.log('initDeleteButton: Showing confirmation dialog');
        if (!confirm(confirmationText)) {
            console.log('initDeleteButton: Confirmation cancelled');
            return;
        }

        console.log('initDeleteButton: Proceeding with delete/hide operation');
        const keyToActOn = selectedProfileKey; // Preserve key

        if (profileRecord.isDraft) {
            // A draft never reached the server — deleteOrHideProfile would
            // 404 trying to DELETE/hide an id that was never POSTed.
            await deleteProfileDraft(keyToActOn);
            document.dispatchEvent(new CustomEvent('profiles-updated'));
        } else {
            await deleteOrHideProfile(keyToActOn);
        }

        // Re-rendering is handled by the 'profiles-updated' event.
        // Now, find the element and re-establish selection to update the UI state.
        const container = document.getElementById('profile-list');
        if (container) {
            const itemToReselect = container.querySelector(`[data-profile-key="${keyToActOn}"]`);
            if (itemToReselect) {
                // Clicking it will handle selection style and update the right pane view
                console.log('initDeleteButton: Re-selecting item after delete/hide');
                itemToReselect.click();
            } else {
                // The item was deleted, not hidden, so clear the view
                console.log('initDeleteButton: Item was deleted, clearing view');
                updateSelectedProfileView(null);
            }
        }
    });
    console.log('initDeleteButton: Event listener attached');
}

function initViewButton() {
    console.log('initViewButton: Starting initialization');
    const viewButton = document.getElementById('view_profile');
    const page_title = document.getElementById("page_title");
    console.log('initViewButton: viewButton found:', !!viewButton);
    console.log('initViewButton: page_title found:', !!page_title);

    if (!viewButton) {
        console.error('initViewButton: view_profile button not found');
        return;
    }

    // Remove any existing click listeners to prevent duplicates
    // Create a new button element to clear all event listeners
    const newViewButton = viewButton.cloneNode(true);
    viewButton.parentNode.replaceChild(newViewButton, viewButton);

    // Use the cloned button (which has no event listeners)
    const button = newViewButton;

    // Set initial state on load, corresponding to isShowingHidden = false (default bg, blue icon)
    button.innerHTML = getEyeIconSVG('#385a92'); // Blue icon
    button.classList.remove("bg-[var(--mimoja-blue)]");
    button.classList.add("bg-[var(--button-grey)]"); // Use CSS variable for background
    console.log('initViewButton: Initial state set');

    button.addEventListener('click', () => {
        console.log('initViewButton: View button clicked, toggling isShowingHidden');
        isShowingHidden = !isShowingHidden;

        if (isShowingHidden) {
            // State: SHOWING hidden profiles -> blue background, white icon
            button.innerHTML = getEyeIconSVG('currentColor');
            // Use direct style manipulation instead of Tailwind arbitrary values
            button.style.backgroundColor = 'var(--mimoja-blue)';
            button.classList.remove("bg-[var(--button-grey)]");
            if (page_title) {
                page_title.textContent = "All Profiles";
            }
            console.log('initViewButton: Now showing hidden profiles');
        } else {
            // State: HIDING hidden profiles -> default background, blue icon
            button.innerHTML = getEyeIconSVG('#385a92');
            // Reset to default background
            button.style.backgroundColor = '';
            button.classList.add("bg-[var(--button-grey)]");
            if (page_title) {
                page_title.textContent = "Profiles";
            }
            console.log('initViewButton: Now hiding hidden profiles');
        }

        // Force a reflow to ensure style changes are applied
        button.offsetHeight;

        console.log('initViewButton: Calling renderProfiles');
        renderProfiles();
    });
    console.log('initViewButton: Event listener attached');
}

function initSearchButton() {
    console.log('initSearchButton: Starting initialization');
    const searchButton = document.getElementById('search_profile');
    const deleteButton = document.getElementById('delete_profile');
    console.log('initSearchButton: searchButton found:', !!searchButton);
    console.log('initSearchButton: deleteButton found:', !!deleteButton);

    if (!searchButton) {
        console.error('initSearchButton: search_profile button not found');
        return;
    }

    if (!deleteButton) {
        console.error('initSearchButton: delete_profile button not found');
        return;
    }

    // Remove any existing click listeners to prevent duplicates
    // Create a new button element to clear all event listeners
    const newSearchButton = searchButton.cloneNode(true);
    searchButton.parentNode.replaceChild(newSearchButton, searchButton);

    // Use the cloned button (which has no event listeners)
    const button = newSearchButton;

    // Set initial state on load (default bg, blue icon)
    button.innerHTML = `<svg class="w-[36px] h-[36px]" viewBox="0 0 66 66" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M30.25 52.25C42.4003 52.25 52.25 42.4003 52.25 30.25C52.25 18.0997 42.4003 8.25 30.25 8.25C18.0997 8.25 8.25 18.0997 8.25 30.25C8.25 42.4003 18.0997 52.25 30.25 52.25Z" stroke="#385A92" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M57.7498 57.7508L45.9248 45.9258" stroke="#385A92" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`; // Blue icon
    button.classList.remove("bg-[var(--mimoja-blue)]");
    button.classList.add("bg-[var(--button-grey)]"); // Use CSS variable for background
    console.log('initSearchButton: Initial state set');

    let searchInput = null;

    button.addEventListener('click', () => {
        console.log('initSearchButton: Search button clicked, toggling search mode');
        isSearching = !isSearching;

        if (isSearching) {
            // Enter search mode
            button.innerHTML = `<svg aria-hidden="true" class="w-[36px] h-[36px]" viewBox="0 0 66 66" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M30.25 52.25C42.4003 52.25 52.25 42.4003 52.25 30.25C52.25 18.0997 42.4003 8.25 30.25 8.25C18.0997 8.25 8.25 18.0997 8.25 30.25C8.25 42.4003 18.0997 52.25 30.25 52.25Z" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M57.7498 57.7508L45.9248 45.9258" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`; // Blue icon
            // Use direct style manipulation instead of Tailwind arbitrary values
            button.style.backgroundColor = 'var(--mimoja-blue)';
            button.classList.remove("bg-[var(--button-grey)]");

            // Create search input field between search_profile and delete_profile buttons
            if (button.parentNode && deleteButton) {
                // Create input field
                searchInput = document.createElement('input');
                searchInput.type = 'search';
                searchInput.enterKeyHint = 'search';
                searchInput.placeholder = 'Search profile names...';
                searchInput.setAttribute('aria-label', 'Search profile names');
                searchInput.className = 'w-[400px] h-[82px] mx-[30px] px-4 py-2 rounded-[20px] border border-solid border-[var(--border-color)] text-[var(--text-primary)] bg-[var(--profile-button-background-color)] focus:outline-none focus:ring-2 focus:ring-[var(--mimoja-blue)]';
                searchInput.style.fontSize = '28px';
                searchInput.style.fontWeight = 'bold';

                // Find the element between search and delete buttons and insert the search input there
                const parentElement = button.parentNode;
                const searchIndex = Array.prototype.indexOf.call(parentElement.children, button);
                const deleteIndex = Array.prototype.indexOf.call(parentElement.children, deleteButton);

                // Ensure search button comes before delete button in the DOM
                if (searchIndex < deleteIndex) {
                    // Insert after the search button but before the delete button
                    parentElement.insertBefore(searchInput, deleteButton);
                } else {
                    // If delete button comes before search, insert after search button
                    parentElement.insertBefore(searchInput, button.nextSibling);
                }

                // Focus the input
                searchInput.focus();

                // Add event listener to handle search input
                let searchTimeout;
                searchInput.addEventListener('input', (e) => {
                    // Clear previous timeout
                    clearTimeout(searchTimeout);

                    // Set new timeout to debounce search
                    searchTimeout = setTimeout(() => {
                        const searchTerm = e.target.value.toLowerCase();
                        console.log('initSearchButton: Searching for:', searchTerm);

                        // Filter profiles based on search term
                        filterProfiles(searchTerm);
                    }, 300); // 300ms delay before triggering search
                });

                // Enter / keyboard search key: filter, then dismiss the soft
                // keyboard by blurring. 'search' fires for type=search; keep
                // Enter as a fallback for keyboards that send it instead.
                const runSearchAndDismiss = (e) => {
                    const searchTerm = e.target.value.toLowerCase();
                    console.log('initSearchButton: Searching for (search key):', searchTerm);
                    filterProfiles(searchTerm);
                    searchInput.blur();
                };
                searchInput.addEventListener('search', runSearchAndDismiss);
                searchInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        runSearchAndDismiss(e);
                    }
                });

                // Add event listener to handle Escape key to exit search
                searchInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') {
                        exitSearchMode();
                    }
                });
            }
        } else {
            // Exit search mode
            exitSearchMode();
        }
    });
    console.log('initSearchButton: Event listener attached');
}

function exitSearchMode(originalTitle = null) {
    const searchButton = document.getElementById('search_profile');
    const page_title = document.getElementById("page_title");
    console.log('exitSearchMode: Exiting search mode');

    // Reset the global search state
    isSearching = false;

    if (searchButton) {
        // Reset the search button to its original state
        searchButton.innerHTML = `<svg class="w-[36px] h-[36px]" viewBox="0 0 66 66" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M30.25 52.25C42.4003 52.25 52.25 42.4003 52.25 30.25C52.25 18.0997 42.4003 8.25 30.25 8.25C18.0997 8.25 8.25 18.0997 8.25 30.25C8.25 42.4003 18.0997 52.25 30.25 52.25Z" stroke="#385A92" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M57.7498 57.7508L45.9248 45.9258" stroke="#385A92" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`; // Blue icon
        // Reset to default background
        searchButton.style.backgroundColor = '';
        searchButton.classList.add("bg-[var(--button-grey)]");
    }

    // Remove the search input if it exists
    const searchInput = document.querySelector('#search_profile + input[type="text"]');
    if (searchInput) {
        searchInput.remove();
    }

    if (page_title) {
        // Restore original title if needed
        if (page_title.textContent !== 'Profiles') {
            page_title.textContent = originalTitle || 'Profiles';
        }
    }

    // Reset the search state and show all profiles
    renderProfiles();
}

// Wrap occurrences of `term` in the title with the same yellow <mark> style as
// settings search. Escapes HTML and the regex so odd titles/queries can't break.
function highlightTitle(text, term) {
    const safe = text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    if (!term) return safe;
    const escTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(`(${escTerm})`, 'gi'), '<mark class="bg-yellow-300 text-black">$1</mark>');
}

function filterProfiles(searchTerm) {
    console.log('filterProfiles: Filtering profiles for term:', searchTerm);

    const container = document.getElementById('profile-list');
    if (!container) {
        console.error('filterProfiles: Profile list container not found');
        return;
    }

    // Clear the container
    container.innerHTML = '';

    // Get all available profiles
    const profileEntries = Object.entries(availableProfiles);

    // Filter profiles based on search term
    const filteredProfiles = profileEntries.filter(([, profileRecord]) => {
        if (!profileRecord.profile) return false;

        const profileTitle = profileRecord.profile.title ? profileRecord.profile.title.toLowerCase() : '';

        // A search is a deliberate look for a specific profile by name, hidden
        // ones included -- unlike the plain list, which still respects the
        // isShowingHidden toggle. A hidden match renders in the same lighter
        // text (and with the same unhide button) as the toggled-on list view,
        // below, so it reads as distinct without needing the toggle first.
        return profileTitle.includes(searchTerm);
    });

    // Sort the filtered profiles
    const sortedProfiles = filteredProfiles.sort(([, a], [, b]) => {
        if (a.profile && a.profile.title && b.profile && b.profile.title) {
            return translateProfileTitle(a.profile.title).localeCompare(translateProfileTitle(b.profile.title));
        }
        return 0;
    });

    if (sortedProfiles.length === 0) {
        console.log('filterProfiles: No profiles match the search term');
        container.textContent = 'No profiles found.';
        updateSelectedProfileView(null); // Clear right panel
        return;
    }

    // Add filtered profiles to the container
    for (const [key, profileRecord] of sortedProfiles) {
        const profile = profileRecord.profile;
        if (!profile) continue;

        const isHidden = profileRecord.visibility === 'hidden';
        console.log('filterProfiles: Adding profile to filtered list', profile.title, 'isHidden:', isHidden);

        const displayTitle = translateProfileTitle(profile.title) || 'Untitled Profile';

        const div = document.createElement('div');
        div.className = 'p-3 text-[30px] cursor-pointer flex justify-between items-center no-select';
        div.dataset.profileKey = key;
        div.dataset.profileTitle = displayTitle;
        div.setAttribute('role', 'option');
        div.setAttribute('aria-selected', 'false');
        div.setAttribute('aria-label', displayTitle);

        const leftSide = document.createElement('div');
        leftSide.className = 'flex items-baseline gap-2 min-w-0';
        const titleSpan = document.createElement('span');
        titleSpan.innerHTML = highlightTitle(displayTitle, searchTerm);
        leftSide.appendChild(titleSpan);

        const parentRecord = profileRecord.parentId ? availableProfiles[profileRecord.parentId] : null;
        const parentTitle = parentRecord?.profile?.title;
        if (parentTitle) {
            const badge = document.createElement('span');
            badge.className = 'text-[16px] px-2 py-0.5 rounded-full bg-white/15 whitespace-nowrap';
            badge.textContent = `from ${translateProfileTitle(parentTitle)}`;
            leftSide.appendChild(badge);
        }
        div.appendChild(leftSide);

        if (isHidden) {
            div.classList.add('text-[var(--low-contrast-white)]');
            const unhideButton = document.createElement('button');
            unhideButton.className = 'p-1 hover:bg-gray-200 rounded-full';
            unhideButton.title = 'Show this profile';
            unhideButton.setAttribute('aria-label', `Show profile ${displayTitle}`);
            unhideButton.innerHTML = `<svg class="w-6 h-6" aria-hidden="true" viewBox="0 0 66 66" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 33C5.5 33 13.75 13.75 33 13.75C52.25 13.75 60.5 33 60.5 33C60.5 33 52.25 52.25 33 52.25C13.75 52.25 5.5 33 5.5 33Z" stroke="#385A92" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 41.25C37.5563 41.25 41.25 37.5563 41.25 33C41.25 28.4437 37.5563 24.75 33 24.75C28.4437 24.75 24.75 28.4437 24.75 33C24.75 37.5563 28.4437 41.25 33 41.25Z" stroke="#385A92" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

            unhideButton.addEventListener('click', async (e) => {
                e.stopPropagation();
                console.log('filterProfiles: Unhide button clicked for profile', key);
                await unhideProfileEntry(key);
                filterProfiles(searchTerm); // Re-filter after unhiding
            });
            div.appendChild(unhideButton);
        } else {
            div.classList.add('text-[var(--text-primary)]');
        }

        div.addEventListener('click', (e) => {
            console.log('filterProfiles: Profile item clicked:', profile.title);
            const clickedItem = e.currentTarget;

            const allItems = clickedItem.parentElement.querySelectorAll('[data-profile-key]');
            for(const item of allItems) {
                item.classList.remove('bg-[#385a92]', 'text-white', 'rounded-[8px]', 'bg-gray-200', 'text-black');
                item.setAttribute('aria-selected', 'false');
                const itemKey = item.dataset.profileKey;
                if (itemKey && availableProfiles[itemKey] && availableProfiles[itemKey].visibility === 'hidden') {
                    item.classList.add('text-[var(--low-contrast-white)]');
                } else {
                    item.classList.add('text-[var(--text-primary)]');
                }
            }

            if (isHidden) {
                clickedItem.classList.add('bg-gray-200', 'rounded-[8px]');
                clickedItem.classList.remove('text-white');

            } else {
                clickedItem.classList.add('bg-[#385a92]', 'text-white', 'rounded-[8px]');
                clickedItem.classList.remove('text-[#121212]');
            }

            clickedItem.setAttribute('aria-selected', 'true');
            // Update the selected profile view first
            updateSelectedProfileView(clickedItem);

            // Then exit search mode to preserve the selection
            exitSearchMode();
        });

        container.appendChild(div);
    }

    // Clear selection since we're in search mode
    selectedProfileKey = null;

    console.log('filterProfiles: Added', sortedProfiles.length, 'profiles to filtered list');
}


// Main initialization function that can be called externally
export async function initializeProfileSelector() {
    console.log('initializeProfileSelector: Starting initialization');

    const pageRoot =
        document.querySelector('div[role="dialog"][aria-labelledby="page_title"]')
        || document.getElementById('profile-editor-grid');
    if (!pageRoot || initializedProfileRoots.has(pageRoot)) return;
    initializedProfileRoots.add(pageRoot);

    // Reset the selected profile key to ensure first profile gets selected on page load
    selectedProfileKey = null;
    selectionIsFallback = false;

    translatePage();
    console.log('initializeProfileSelector: i18n translated');

    // Suppress browser-default selection/long-press/drag/callout across the whole
    // profile-selector page. Delegated listeners on the root also cover items
    // added later by renderProfiles() / filterProfiles().
    suppressBrowserActions(pageRoot);

    // Fetching the profiles is the long pole and needs nothing from the DOM, so
    // start it before touching the chart. This used to run second, behind an
    // unconditional 50ms setTimeout and a chart init the list does not depend
    // on -- roughly 80ms of dead time before the request was even issued here,
    // and far worse on a tablet where chart init is CPU-bound.
    const profilePromise = initProfileManager();

    // The router injects the page HTML and awaits a requestAnimationFrame before
    // calling us (router.js), so the element is already in the DOM -- the old
    // retry ladder was guarding a race that no longer exists.
    if (document.getElementById('plotly-chart')) {
        initChart();
    } else {
        console.warn('Chart element not found; skipping chart init');
    }

    // availableProfiles is module state in profileManager.js and isn't cleared
    // until the fetch above actually resolves (see loadAvailableProfiles), so
    // on a return visit within the same session it still holds last visit's
    // data right now. Paint immediately from that instead of waiting on the
    // network round trip -- this is what was making the chart take 1-2s to
    // appear on every nav in/out. Reconciled below once the real fetch lands.
    if (Object.keys(availableProfiles).length > 0) {
        renderProfiles();
    }

    const profileLoadStatus = await profilePromise;
    console.log('initializeProfileSelector: Profile manager initialized, status:', profileLoadStatus);

    if (profileLoadStatus?.profilesFrom === 'API') {
        logger.info('Profiles loaded successfully from API.');
    } else if (profileLoadStatus?.profilesFrom === 'IDB_CACHE') {
        showToast('Offline: Displaying cached profiles.', 3000, 'warning');
    } else {
        showToast('Error: Could not load any profiles.', 3000, 'error');
    }

    console.log('initializeProfileSelector: Rendering profiles...');
    renderProfiles();

    // findActiveProfileKey only answers once the main page has bound the active
    // profile, and that runs off loadInitialData, which waits on the DE1
    // connecting. Tap the profile name inside that window and the list falls
    // back to its first row: the preview graph draws a profile the machine
    // isn't running, and CONFIRM would send it. The workflow knows what is
    // loaded, so ask it and redo the selection through the normal path.
    if (selectionIsFallback) {
        try {
            const workflow = await getWorkflow();
            const key = resolveProfileKeyByTitle(availableProfiles, workflow?.profile?.title, translateProfileTitle);
            if (key && key !== selectedProfileKey) {
                setActiveProfile(key);
                selectedProfileKey = null;
                renderProfiles();
            }
        } catch (e) {
            logger.warn('Could not resolve the loaded profile from the workflow:', e.message);
        }
    }

    // Clear cached credentials so we always get fresh data
    cachedVisualizerCredentials = null;

    // Initialize modals
    initModals();

    // Wire up add profile button
    const originalAddProfileButton = document.getElementById('add_profile');
    if (originalAddProfileButton) {
        console.log('initializeProfileSelector: Setting up add profile button');
        // Remove any existing click listeners to prevent duplicates
        const newAddProfileButton = originalAddProfileButton.cloneNode(true);
        originalAddProfileButton.parentNode.replaceChild(newAddProfileButton, originalAddProfileButton);

        newAddProfileButton.addEventListener('click', () => {
            window.__pendingEditProfile = {
                id: null,
                profile: {
                    title: 'New Profile',
                    version: '2',
                    beverage_type: 'espresso',
                    target_weight: 0,
                    tank_temperature: 0,
                    target_volume: 0,
                    target_volume_count_start: 0,
                    author: '',
                    notes: '',
                    steps: [
                        {
                            name: 'Preinfusion',
                            pump: 'flow',
                            transition: 'fast',
                            flow: 2.0,
                            temperature: 93,
                            sensor: 'coffee',
                            seconds: 10,
                            weight: 0,
                            volume: 0,
                            exit: { type: 'pressure', condition: 'over', value: 4.0 },
                            limiter: { value: 4.0, range: 0.6 },
                        },
                        {
                            name: 'Ramp',
                            pump: 'flow',
                            transition: 'fast',
                            flow: 6.0,
                            temperature: 93,
                            sensor: 'coffee',
                            seconds: 20,
                            weight: 0,
                            volume: 0,
                            exit: { type: 'pressure', condition: 'over', value: 9.0 },
                            limiter: { value: 9.0, range: 0.6 },
                        },
                        {
                            name: 'Extraction',
                            pump: 'pressure',
                            transition: 'fast',
                            pressure: 9.0,
                            temperature: 93,
                            sensor: 'coffee',
                            seconds: 40,
                            weight: 37,
                            volume: 0,
                            exit: null,
                            limiter: null,
                        },
                    ],
                },
            };
            loadPage('src/profiles/profile_editor.html');
        });
        // Also handle the file input to prevent duplicate listeners
        const originalFileInput = document.getElementById('profile-upload-input');
        if (originalFileInput) {
            const newFileInput = originalFileInput.cloneNode(true);
            originalFileInput.parentNode.replaceChild(newFileInput, originalFileInput);
            newFileInput.addEventListener('change', handleProfileUpload);
        }
    }

    ensureProfilesUpdatedListener();

    console.log('initializeProfileSelector: Initializing resizable panels');
    initResizablePanels('separator');
    console.log('initializeProfileSelector: Setting up confirm button');
    const confirmBtn = document.getElementById('confirm-profile-btn');
    if (confirmBtn) {
        // Remove any existing click listeners to prevent duplicates
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        newConfirmBtn.addEventListener('click', handleConfirm);
    }

    console.log('initializeProfileSelector: Setting up cancel button');
    const cancelBtn = document.getElementById('cancel-profile-btn');
    if (cancelBtn) {
        // Remove any existing click listeners to prevent duplicates
        const newCancelBtn = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
        newCancelBtn.addEventListener('click', handleCancel);
    }
    console.log('initializeProfileSelector: Initializing delete button');
    initDeleteButton();
    console.log('initializeProfileSelector: Initializing view button');
    initViewButton();
    console.log('initializeProfileSelector: Initializing favorite buttons');
    await initFavoriteButtons();
    console.log('initializeProfileSelector: Initializing search button');
    initSearchButton();
    console.log('initializeProfileSelector: Initializing fullscreen handler');
    initFullscreenHandler();


    const editProfileBtnRaw = document.getElementById('edit_profile');
    const editProfileBtn = editProfileBtnRaw ? (() => {
        const clone = editProfileBtnRaw.cloneNode(true);
        editProfileBtnRaw.parentNode.replaceChild(clone, editProfileBtnRaw);
        return clone;
    })() : null;
    if (editProfileBtn) {
        editProfileBtn.addEventListener('click', () => {
            console.log('[EditBtn] clicked. selectedProfileKey=', selectedProfileKey);
            if (!selectedProfileKey) {
                showToast('Select a profile first', 3000, 'error');
                return;
            }
            const profileRecord = availableProfiles[selectedProfileKey];
            console.log('[EditBtn] profileRecord=', profileRecord);
            if (!profileRecord) {
                console.warn('[EditBtn] profileRecord is null/undefined, aborting');
                return;
            }
            console.log('[EditBtn] Setting window.__pendingEditProfile and navigating...');
            window.__pendingEditProfile = profileRecord;
            console.log('[EditBtn] window.__pendingEditProfile set:', window.__pendingEditProfile?.profile?.title);
            loadPage('src/profiles/profile_editor.html');
        });
    } else {
        console.warn('[EditBtn] #edit_profile button not found in DOM');
    }

    // Wire reset button
    const resetBtnRaw = document.getElementById('reset_btn');
    const resetBtn = resetBtnRaw ? (() => {
        const clone = resetBtnRaw.cloneNode(true);
        resetBtnRaw.parentNode.replaceChild(clone, resetBtnRaw);
        return clone;
    })() : null;
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (!selectedProfileKey) {
                showToast('Select a profile first', 3000, 'error');
                return;
            }
            const profileRecord = availableProfiles[selectedProfileKey];
            if (!profileRecord) return;

            if (!profileRecord.parentId) {
                showToast('This is an original profile — nothing to reset.', 3000, 'info');
                return;
            }

            const title = translateProfileTitle(profileRecord.profile?.title) || 'this profile';
            const msgEl = document.getElementById('reset-profile-msg');
            if (msgEl) msgEl.textContent = `"${title}" is a saved copy. Resetting will delete it and restore the original. This cannot be undone.`;

            const modal = document.getElementById('reset-profile-modal');
            if (modal) modal.showModal();
        });
    }

    const resetCancelBtnRaw = document.getElementById('reset-profile-cancel');
    const resetCancelBtn = resetCancelBtnRaw ? (() => {
        const clone = resetCancelBtnRaw.cloneNode(true);
        resetCancelBtnRaw.parentNode.replaceChild(clone, resetCancelBtnRaw);
        return clone;
    })() : null;
    if (resetCancelBtn) {
        resetCancelBtn.addEventListener('click', () => {
            document.getElementById('reset-profile-modal')?.close();
        });
    }

    const resetConfirmBtnRaw = document.getElementById('reset-profile-confirm');
    const resetConfirmBtn = resetConfirmBtnRaw ? (() => {
        const clone = resetConfirmBtnRaw.cloneNode(true);
        resetConfirmBtnRaw.parentNode.replaceChild(clone, resetConfirmBtnRaw);
        return clone;
    })() : null;
    if (resetConfirmBtn) {
        resetConfirmBtn.addEventListener('click', async () => {
            document.getElementById('reset-profile-modal')?.close();
            if (!selectedProfileKey) return;

            const profileRecord = availableProfiles[selectedProfileKey];
            const parentId = profileRecord?.parentId || null;
            if (!parentId) return;

            try {
                await deleteProfile(selectedProfileKey);
                delete availableProfiles[selectedProfileKey];
                selectedProfileKey = availableProfiles[parentId] ? parentId : null;
                renderProfiles();
                // updateSelectedProfileView expects the rendered DOM element, not the record
                const nextItem = selectedProfileKey
                    ? document.querySelector(`#profile-list [data-profile-key="${CSS.escape(selectedProfileKey)}"]`)
                    : null;
                updateSelectedProfileView(nextItem);
                showToast('Profile reset to original.', 2500, 'success');
            } catch (e) {
                console.error('[ResetProfile] delete failed:', e);
                showToast(`Failed to reset profile: ${e.message}`, 4000, 'error');
            }
        });
    }

    await initAiGenerateButton();
    console.log('initializeProfileSelector: Initialization complete');
}

async function initAiGenerateButton() {
    const link = document.getElementById('ai_generate_profile');
    if (!link) return;

    try {
        const resp = await fetch(`${API_BASE_URL}/plugins`);
        if (!resp.ok) throw new Error('plugins fetch failed');
        const plugins = await resp.json();
        const plugin = plugins.find(p => p.id === 'decent-profile.reaplugin');
        if (!plugin?.loaded) { link.style.display = 'none'; return; }
    } catch {
        link.style.display = 'none';
        return;
    }

    // No profileGenerated WS subscription here on purpose: a generated profile
    // must never be auto-imported. The plugin's "upload to Decent" button is the
    // only path — it uploads on explicit user action. Subscribing here re-imported
    // the WS's retained last generation on every page open (spurious green toast).

    // Point the link at the SAME reaprime the skin talks to (reaHostname), not a
    // hardcoded localhost. Otherwise, when reaHostname is a remote/device IP, the
    // plugin opens on localhost and its "Upload to Decent" POST /api/v1/profiles
    // saves to a DIFFERENT server than the skin lists from — the profile persists
    // but never shows up here. API_BASE_URL already encodes host:port.
    link.href = `${API_BASE_URL}/plugins/decent-profile.reaplugin/ui?layout=baseline`;

    // Set the output format once now (not on click) so the tap can navigate
    // natively — the plain <a href> (no target) is a same-frame navigation, which
    // the host intercepts to open the OS browser with the plugin URL (gh#384).
    setPluginSettings('decent-profile.reaplugin', { profileFormat: 'json-v2' })
        .catch((err) => logger.warn('Could not set profileFormat=json-v2:', err));

    // The anchor's own same-frame navigation performs the tap; we only add a flag
    // handler so we know the user left for the plugin. The plugin's "Upload to
    // Decent" saves via POST /api/v1/profiles, so when the user returns we just
    // re-pull the library and it appears. Same-frame nav guarantees the skin page
    // is either hidden (webview -> OS browser) or unloaded (browser), so one of
    // pageshow/visibilitychange always fires on return.
    const fresh = link.cloneNode(true); // drop stale listeners
    link.parentNode.replaceChild(fresh, link);
    fresh.addEventListener('click', () => { window.__reaAwaitGeneratedProfile = true; });

    // Register the return-listeners once — initAiGenerateButton re-runs on every
    // dynamic-content-loaded, so guard against stacking duplicate handlers.
    if (!window.__reaProfileRefreshWired) {
        window.__reaProfileRefreshWired = true;
        const refreshIfReturning = async () => {
            if (!window.__reaAwaitGeneratedProfile) return;
            if (document.visibilityState === 'hidden') return; // wait until actually shown
            window.__reaAwaitGeneratedProfile = false;
            await initProfileManager(); // re-fetch /api/v1/profiles into availableProfiles
            renderProfiles();
            // The plugin's "Upload to Decent" also does PUT /workflow, making the
            // uploaded profile the active one. Re-pull the workflow so #profile-name
            // (and the dose/grind/steam displays) reflect the new active profile.
            try {
                const workflow = await getWorkflow();
                if (workflow) applyWorkflowToMainPageUI(workflow); // updateName defaults true
            } catch (e) {
                logger.warn('Workflow refresh after profile upload failed:', e);
            }
        };
        document.addEventListener('visibilitychange', refreshIfReturning);
        window.addEventListener('pageshow', refreshIfReturning); // bfcache restore (browser)
    }
}

// Call initialization when DOM is ready for traditional page loads
document.addEventListener('DOMContentLoaded', initializeProfileSelector);

// Also call initialization when dynamic content is loaded via router
document.addEventListener('dynamic-content-loaded', (event) => {
    // Check if this event is for profile selector
    if (event.detail.pageUrl && (event.detail.pageUrl.includes('profile_selector.html') || event.detail.pageUrl.endsWith('profile_selector.html'))) {
        initializeProfileSelector();
    }
});
