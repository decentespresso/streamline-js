export function autoSteamFlowSettings(status) {
    const calibration = status.flowCalibration;
    if (calibration?.mode === 'multiple') {
        const { minimum, maximum, defaultFlow } = calibration;
        if (calibration.adjustable !== true || ![minimum, maximum, defaultFlow].every(Number.isFinite) ||
            minimum < 0.4 || maximum > 2.5 || maximum - minimum < 0.099999 || defaultFlow < minimum || defaultFlow > maximum) return null;
        return { adjustable: true, minimum, maximum, defaultFlow };
    }
    if (status.settings?.calibrationMode === 'multiple') return null;
    const flow = status.settings?.referenceFlow;
    return Number.isFinite(flow) && flow >= 0.4 && flow <= 2.5 ? { adjustable: false, minimum: flow, maximum: flow, defaultFlow: flow } : null;
}

export function steamAdjustmentControls(mode, session = {}, machineState) {
    if (mode !== 'auto') return { visible: true, minusDisabled: session.busy === true, plusDisabled: session.busy === true };
    const visible = session.adjustableFlow === true;
    const disabled = !visible || session.busy === true || session.configurationReady !== true || machineState !== 'idle';
    return { visible, minusDisabled: disabled || session.flow <= session.minimumFlow, plusDisabled: disabled || session.flow >= session.maximumFlow };
}
