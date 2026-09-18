function validFlow(value) {
    return Number.isFinite(value) && value >= 0.4 && value <= 2.5;
}

function validSavedChoice(choice) {
    return choice && typeof choice.key === 'string' && choice.key.length > 0 && choice.key.length <= 256 &&
        validFlow(choice.flow) && Number.isFinite(choice.targetTemperatureC) &&
        choice.targetTemperatureC > 0 && choice.targetTemperatureC <= 100 &&
        typeof choice.targetLabel === 'string' && choice.targetLabel.length > 0 && choice.targetLabel.length <= 32;
}

export function autoSteamSelectionSettings(status) {
    const calibration = status?.flowCalibration;
    if (calibration?.mode === 'saved') {
        const choices = Array.isArray(calibration.choices) ? calibration.choices : [];
        const keys = choices.map(choice => choice?.key);
        const adjustable = choices.length > 1;
        if (!choices.length || choices.some(choice => !validSavedChoice(choice)) ||
            new Set(keys).size !== keys.length || calibration.adjustable !== adjustable ||
            typeof calibration.defaultCalibrationKey !== 'string' ||
            !keys.includes(calibration.defaultCalibrationKey)) return null;
        return {
            kind: 'calibration',
            adjustable,
            defaultCalibrationKey: calibration.defaultCalibrationKey,
            choices: choices.map(choice => ({ ...choice })),
        };
    }
    if (calibration?.mode === 'interpolate') {
        const { minimum, maximum, defaultFlow, step } = calibration;
        if (calibration.adjustable !== true || ![minimum, maximum, defaultFlow, step].every(Number.isFinite) ||
            minimum < 0.4 || maximum > 2.5 || maximum - minimum < 0.099999 ||
            defaultFlow < minimum || defaultFlow > maximum || Math.abs(step - 0.1) > 0.000001) return null;
        return { kind: 'flow', adjustable: true, minimum, maximum, defaultFlow, step };
    }
    return null;
}

export function steamAdjustmentControls(mode, session = {}, machineState) {
    if (mode !== 'auto') return { visible: true, minusDisabled: session.busy === true, plusDisabled: session.busy === true };
    const visible = session.adjustableSelection === true;
    const disabled = !visible || session.busy === true || session.configurationReady !== true || machineState !== 'idle';
    if (session.adjustmentKind === 'calibration') {
        return { visible, minusDisabled: disabled, plusDisabled: disabled };
    }
    return {
        visible,
        minusDisabled: disabled || session.flow <= session.minimumFlow,
        plusDisabled: disabled || session.flow >= session.maximumFlow,
    };
}

export function autoSteamDurationLabel(duration, targetLabel = null) {
    return compactAutoSteamTargetLabel(targetLabel) || `${duration}s`;
}

export function compactAutoSteamTargetLabel(targetLabel) {
    if (typeof targetLabel !== 'string' || !targetLabel.trim()) return '';
    return targetLabel.trim().replace(/\.0(?=\s*°)/, '').replace(/\s+/g, '');
}

export function autoSteamPitcherLabel(pitcher, selectedPitcher, targetLabel) {
    const base = { small: 'S', medium: 'M', large: 'L', auto: 'Auto' }[pitcher] ?? '';
    const target = pitcher === selectedPitcher ? compactAutoSteamTargetLabel(targetLabel) : '';
    return target ? `${base} · ${target}` : base;
}

export function shouldKeepAutoSteamMode(error) {
    return error?.status === 422;
}
