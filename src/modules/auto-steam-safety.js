export const AUTO_STEAM_BOUNDS = Object.freeze({
    duration: Object.freeze({ minimum: 0, maximum: 255 }),
    flow: Object.freeze({ minimum: 0, maximum: 2.5 }),
});

function finiteNumber(value, name) {
    if (!Number.isFinite(value)) throw new Error(`Invalid Auto steam ${name}.`);
    return value;
}

export function clampAutoSteamSettings(steam) {
    const duration = Math.round(finiteNumber(steam?.duration, 'duration'));
    const flow = finiteNumber(steam?.flow, 'flow');
    const targetTemperature = steam?.targetTemperature === undefined
        ? undefined : finiteNumber(steam.targetTemperature, 'heater temperature');
    const stopAtTemperature = steam?.stopAtTemperature === undefined
        ? undefined : finiteNumber(steam.stopAtTemperature, 'stop temperature');

    if ((targetTemperature !== undefined && (!Number.isInteger(targetTemperature) || targetTemperature < 0 || targetTemperature > 165)) ||
        (stopAtTemperature !== undefined && (stopAtTemperature < 0 || stopAtTemperature > 80))) {
        throw new Error('Invalid Auto steam temperature settings.');
    }

    return {
        duration: Math.max(AUTO_STEAM_BOUNDS.duration.minimum, Math.min(AUTO_STEAM_BOUNDS.duration.maximum, duration)),
        flow: Math.max(AUTO_STEAM_BOUNDS.flow.minimum, Math.min(AUTO_STEAM_BOUNDS.flow.maximum, flow)),
        ...(targetTemperature === undefined ? {} : { targetTemperature }),
        ...(stopAtTemperature === undefined ? {} : { stopAtTemperature }),
    };
}
