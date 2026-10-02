import {
    currentMachineState,
    ensureMachineSnapshotSocket,
    getLastMachineSnapshot,
    MachineState,
    setMachineState,
    setSteamHeaterEnabled,
} from '../../modules/api.js';
import {
    CLEANING_PROCEDURE,
    DESCALE_STEAM_MAX_C,
    DESCALING_PROCEDURE,
    STEAM_COOLDOWN_TIMEOUT_MS,
    WAKE_TIMEOUT_MS,
    advanceProcedureState,
    initialProcedureState,
    isAwake,
    isProcedureActive,
    procedureIndicatorView,
    shouldWakeBeforeStart,
    startedProcedureState,
    steamCoolEnoughToDescale,
} from '../../modules/maintenance-progress.js';
import { getTranslation, translatePage } from '../../modules/i18n.js';
import { logger } from '../../modules/logger.js';
import * as ui from '../../modules/ui.js';

// Same palette as the load-cell calibration step indicator (calStepIndicator,
// in the legacy settings module), so every multi-step machine procedure reads
// as one design.
const STEP_DONE = '#0ca581';
const STEP_ACTIVE = '#385a92';
const STEP_PENDING = 'var(--button-grey)';

const CAPTION_TONES = {
    info: 'text-[#959595]',
    progress: 'text-[#959595]',
    success: 'text-[#0ca581] font-bold',
    error: 'text-red-500 font-bold',
};

const PRIMARY_BTN = 'bg-[#385a92] h-[72px] px-[48px] rounded-[72px] text-white text-[24px] font-bold';
const DIALOG_BTN = 'bg-[#385a92] h-[62px] px-[32px] rounded-[67.5px] text-white text-[24px] font-bold';
const DIALOG_CANCEL_BTN = 'border-[var(--mimoja-blue)] text-[var(--mimoja-blue)] h-[62px] rounded-[67.5px] border px-[32px] text-[24px] font-bold';

/** Dots + connectors, mirroring calStepIndicator() in the legacy settings module. */
function stepDots(milestone, labels) {
    return labels.map((label, i) => {
        const isDone = i < milestone;
        const isActive = i === milestone;
        const background = isDone ? STEP_DONE : (isActive ? STEP_ACTIVE : STEP_PENDING);
        const color = (isDone || isActive) ? '#ffffff' : '#959595';
        const dot = `<div class="rounded-full flex items-center justify-center text-[22px] font-bold shrink-0" style="width:44px;height:44px;background:${background};color:${color}" title="${getTranslation(label)}">${isDone ? '&#10003;' : i + 1}</div>`;
        const bar = i < labels.length - 1
            ? `<div class="shrink-0" style="width:40px;height:3px;background:${i < milestone ? STEP_DONE : STEP_PENDING}"></div>`
            : '';
        return dot + bar;
    }).join('');
}

/**
 * Cleaning and descaling are the same page with different words: title, one
 * sentence, a Start button that becomes Stop, a confirmation, and the milestone
 * strip. Keeping them in one template is what stops the two drifting apart.
 */
function procedureView({ title, action, description, confirmation, extra = '' }) {
    return `
        <div class="flex flex-col gap-[60px] items-start w-full">
            <h2 class="font-semibold text-[var(--text-primary)] text-[36px] text-center w-full" data-i18n-key="${title}">${title}</h2>
            <hr class="border-t border-[#c9c9c9] w-full">
            <div class="flex flex-col gap-[30px] w-full">
                <div class="flex items-center justify-between w-full">
                    <p class="font-bold text-[#385a92] text-[30px]" data-i18n-key="${title}">${title}</p>
                    <button type="button" data-action="${action}" class="${PRIMARY_BTN}" data-i18n-key="Start">Start</button>
                </div>
                <p class="text-[var(--text-primary)] text-[24px] pr-[220px]" data-i18n-key="${description}">${description}</p>
                ${extra}
                <div class="flex flex-col gap-[16px] w-full" role="status" aria-live="polite" data-procedure-progress hidden>
                    <div class="flex items-center justify-center w-full" style="gap:10px" data-procedure-dots></div>
                    <p class="text-center text-[24px] w-full" data-procedure-caption></p>
                </div>
            </div>
            <dialog data-procedure-confirm class="modal">
                <div class="modal-box bg-[var(--box-color)] max-w-2xl">
                    <h3 class="font-bold text-[28px] text-[var(--text-primary)] mb-2" data-i18n-key="${title}">${title}</h3>
                    <p class="text-[20px] text-[var(--text-primary)] opacity-80 mb-4" data-i18n-key="${confirmation}">${confirmation}</p>
                    <div class="modal-action">
                        <button type="button" data-action="cancel" class="${DIALOG_CANCEL_BTN}" data-i18n-key="Cancel">Cancel</button>
                        <button type="button" data-action="confirm-procedure" class="${DIALOG_BTN}" data-i18n-key="Start">Start</button>
                    </div>
                </div>
            </dialog>
        </div>`;
}

function cleaning() {
    return procedureView({
        title: 'Clean',
        action: 'clean',
        description: 'Run a cleaning cycle to backflush the group head',
        confirmation: '3) Put a blind basket in the portafilter.',
    });
}

function descaling() {
    return procedureView({
        title: 'Machine Descaling',
        action: 'descale',
        description: 'Run a descaling cycle to remove mineral buildup',
        confirmation: 'Prepare to descale',
        extra: `<a href="https://decentespresso.com/docs/de1_descaling_instruction" class="font-semibold text-[#385a92] underline text-[24px]" data-i18n-key="Descaling Instruction">Descaling Instruction</a>`,
    });
}

function airPurge() {
    return `
        <div class="flex flex-col gap-[60px] items-start w-full">
            <h2 class="font-semibold text-[var(--text-primary)] text-[36px] text-center w-full" data-i18n-key="Transport Mode">Transport Mode</h2>
            <hr class="border-t border-[#c9c9c9] w-full">
            <div class="flex flex-col gap-[30px] w-full">
                <div class="flex items-center justify-between w-full">
                    <p class="font-bold text-[#385a92] text-[30px]" data-i18n-key="Transport Mode">Transport Mode</p>
                    <button type="button" data-action="air-purge" class="${PRIMARY_BTN}" data-i18n-key="Start">Start</button>
                </div>
                <p class="text-[var(--text-primary)] text-[24px] pr-[220px]" data-i18n-key="Purges remaining water from inside the machine. Run before packing the machine to prevent leaks during transport.">Purges remaining water from inside the machine. Run before packing the machine to prevent leaks during transport.</p>
            </div>
            <dialog data-air-purge-confirm class="modal">
                <div class="modal-box bg-[var(--box-color)] max-w-2xl">
                    <h3 class="font-bold text-[28px] text-[var(--text-primary)] mb-2" data-i18n-key="Transport Mode">Transport Mode</h3>
                    <p class="text-[20px] text-[var(--text-primary)] opacity-80 mb-4" data-i18n-key="Prepare your espresso machine for transport">Prepare your espresso machine for transport</p>
                    <div class="modal-action">
                        <button type="button" data-action="cancel" class="${DIALOG_CANCEL_BTN}" data-i18n-key="Cancel">Cancel</button>
                        <button type="button" data-action="confirm-air-purge" class="${DIALOG_BTN}" data-i18n-key="Start">Start</button>
                    </div>
                </div>
            </dialog>
        </div>`;
}

const VIEWS = { maint_airpurge: airPurge, maint_cleaning: cleaning, maint_descaling: descaling };
const PROCEDURES = { maint_cleaning: CLEANING_PROCEDURE, maint_descaling: DESCALING_PROCEDURE };
const PROCEDURE_TICK_MS = 1000;

export async function mountSettingsCategory({ container, category }) {
    let timer = 0;
    let active = true;
    const procedure = PROCEDURES[category] ?? null;
    let procedureState = initialProcedureState();
    let startToken = 0;
    // Non-null only while the steam boiler is being cooled before a descale:
    // holds the latest reading so the caption can count it down.
    let coolingTemp = null;
    let steamHeaterOff = false;
    container.innerHTML = (VIEWS[category] ?? descaling)();
    translatePage();

    const steamTemperature = () => getLastMachineSnapshot()?.steamTemperature ?? null;

    // The cooldown is our wait, not the firmware's, so it gets its own caption
    // instead of a milestone: no dot is lit and the live reading is appended to
    // the translated label, which is the only part a CSV column can carry.
    const coolingView = () => (coolingTemp === null ? null : {
        milestone: -1,
        labels: procedure.milestones,
        caption: 'Cool down',
        tone: 'progress',
        suffix: ` ${Math.round(coolingTemp)}\u00b0C \u2192 ${DESCALE_STEAM_MAX_C}\u00b0C`,
    });

    // The cycle runs on the machine, not here, so the only way to report it is
    // to keep reading the snapshot the socket already caches. See
    // maintenance-progress.js for why entry, exit and a silent socket each need
    // handling of their own.
    const renderProcedure = () => {
        const panel = container.querySelector('[data-procedure-progress]');
        if (!panel || !procedure) return;

        // No indicator at all until a cycle is under way.
        const view = coolingView() ?? procedureIndicatorView(procedureState, procedure);
        panel.hidden = !view;
        if (view) {
            container.querySelector('[data-procedure-dots]').innerHTML = stepDots(view.milestone, view.labels);
            const caption = container.querySelector('[data-procedure-caption]');
            caption.className = `text-center text-[24px] w-full ${CAPTION_TONES[view.tone]}`;
            caption.dataset.i18nKey = view.caption;
            caption.textContent = getTranslation(view.caption) + (view.suffix ?? '');
        }

        const button = container.querySelector('[data-action="clean"], [data-action="descale"]');
        if (!button) return;
        const label = isProcedureActive(procedureState) ? 'Stop' : 'Start';
        button.dataset.i18nKey = label;
        button.textContent = getTranslation(label);
    };

    // A sleeping DE1 drops the cleaning request on the floor, so wake it first
    // and wait for the machine to confirm rather than firing both back to back.
    // Best effort: on timeout the start request still goes out, and the cycle's
    // own entry timeout reports it if the machine never enters.
    const waitUntilAwake = async () => {
        const deadline = Date.now() + WAKE_TIMEOUT_MS;
        while (Date.now() < deadline && active) {
            if (isAwake(currentMachineState)) return;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    };

    // Descaling runs descaler through the steam path, so the steam heater has to
    // be off and the boiler down to DESCALE_STEAM_MAX_C before the cycle starts
    // -- exactly the manual step in Decent's descaling instructions. The heater
    // is switched back on (to its remembered temperature) when the cycle ends,
    // is stopped, or the page is left, so descaling never silently kills steam.
    const restoreSteamHeater = () => {
        if (!steamHeaterOff) return;
        steamHeaterOff = false;
        setSteamHeaterEnabled(true).catch(error => logger.error('Restoring the steam heater failed:', error));
    };

    const coolSteamBoiler = async token => {
        await setSteamHeaterEnabled(false);
        steamHeaterOff = true;
        const deadline = Date.now() + STEAM_COOLDOWN_TIMEOUT_MS;
        while (active && token === startToken && !steamCoolEnoughToDescale(steamTemperature())) {
            if (Date.now() > deadline) {
                coolingTemp = null;
                throw new Error(getTranslation('The steam boiler did not cool down. Try again once it is cold.'));
            }
            coolingTemp = steamTemperature();
            renderProcedure();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        coolingTemp = null;
        renderProcedure();
    };

    // Runs for as long as the page is mounted rather than only after Start, so a
    // cycle begun on the machine itself shows up here too.
    const watchProcedure = () => {
        clearInterval(timer);
        timer = setInterval(() => {
            // Nothing has been sent to the machine yet while cooling, so the
            // entry timeout must not run. The cooldown loop does the rendering.
            if (coolingTemp !== null) return;
            const previous = procedureState;
            procedureState = advanceProcedureState(procedureState, {
                state: currentMachineState,
                substate: getLastMachineSnapshot()?.state?.substate ?? null,
                tickMs: PROCEDURE_TICK_MS,
            }, procedure);
            if (procedureState === previous) return;
            if (procedureState.phase === 'done') restoreSteamHeater();
            renderProcedure();
        }, PROCEDURE_TICK_MS);
    };

    const onClick = async event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (!action) return;
        if (action === 'cancel') {
            container.querySelector('[data-air-purge-confirm]')?.close();
            container.querySelector('[data-procedure-confirm]')?.close();
            return;
        }
        if (action === 'clean' || action === 'descale') {
            // The same button stops a run in flight, matching the tap-anywhere
            // abort the DE1 tablet app puts over its cleaning and descaling
            // screens.
            if (isProcedureActive(procedureState)) {
                // Invalidate a start still waiting on the machine to wake, so it
                // cannot fire the cycle after the user has cancelled it.
                startToken += 1;
                coolingTemp = null;
                restoreSteamHeater();
                try {
                    await setMachineState('idle');
                    if (!active) return;
                    procedureState = initialProcedureState();
                    renderProcedure();
                } catch (error) {
                    logger.error(`Stopping ${procedure.state} failed:`, error);
                    ui.showToast(`${getTranslation('Failed to stop')}: ${error.message}`, 5000, 'error');
                }
                return;
            }
            if (currentMachineState === MachineState.NEEDS_WATER) {
                ui.showToast(`${getTranslation('Out of water')} - ${getTranslation('Press the stop button on the group head to override, then tap Start again.')}`, 6000, 'error');
                return;
            }
            container.querySelector('[data-procedure-confirm]')?.showModal();
            return;
        }
        if (action === 'confirm-procedure') {
            container.querySelector('[data-procedure-confirm]')?.close();
            // Show "Starting" up front: waking the machine takes a few seconds,
            // and a button that does nothing in the meantime reads as broken.
            const token = ++startToken;
            procedureState = startedProcedureState();
            renderProcedure();
            try {
                if (shouldWakeBeforeStart(currentMachineState)) {
                    await setMachineState('idle');
                    await waitUntilAwake();
                }
                if (procedure === DESCALING_PROCEDURE) await coolSteamBoiler(token);
                // Stop (or leaving the page) during the wake or the cooldown must
                // not be undone by the start request that was already in flight.
                if (!active || token !== startToken) return;
                await setMachineState(procedure.state);
            } catch (error) {
                if (!active || token !== startToken) return;
                coolingTemp = null;
                restoreSteamHeater();
                logger.error(`Starting ${procedure.state} failed:`, error);
                procedureState = initialProcedureState();
                renderProcedure();
                ui.showToast(`${getTranslation('Failed to start')}: ${error.message}`, 5000, 'error');
            }
            return;
        }
        if (action === 'air-purge') {
            if (currentMachineState === MachineState.NEEDS_WATER) {
                ui.showToast(`${getTranslation('Out of water')} - ${getTranslation('Press the stop button on the group head to override, then tap Start again.')}`, 6000, 'error');
                return;
            }
            container.querySelector('[data-air-purge-confirm]')?.showModal();
            return;
        }
        if (action !== 'confirm-air-purge') return;
        try {
            await setMachineState('airPurge');
            if (!active) return;
            container.querySelector('[data-air-purge-confirm]')?.close();
            ui.showToast(getTranslation('Now removing water from your espresso machine.'), 0, 'info');
            let entered = false;
            const startedAt = Date.now();
            timer = setInterval(() => {
                if (currentMachineState === MachineState.AIR_PURGE) entered = true;
                if (entered && currentMachineState !== MachineState.AIR_PURGE) {
                    clearInterval(timer);
                    timer = 0;
                    ui.showToast(getTranslation('You can turn your machine off once it is out of water. It will then be ready for transport.'), 8000, 'success');
                } else if (Date.now() - startedAt > 300000) {
                    clearInterval(timer);
                    timer = 0;
                    ui.hideToast();
                }
            }, 1000);
        } catch (error) {
            logger.error('Maintenance command failed:', error);
            ui.showToast(`${getTranslation('Failed to start')}: ${error.message}`, 5000, 'error');
        }
    };

    if (procedure) {
        // The status is only as good as the snapshot stream behind it. Booting
        // straight onto Settings skips initMainPageOnce(), so nothing has opened
        // this socket and currentMachineState would sit at null -- which read as
        // "the machine never started" while it was mid-cycle.
        ensureMachineSnapshotSocket();
        watchProcedure();
    }

    container.addEventListener('click', onClick);
    return () => {
        active = false;
        coolingTemp = null;
        restoreSteamHeater();
        container.removeEventListener('click', onClick);
        if (timer) clearInterval(timer);
    };
}
