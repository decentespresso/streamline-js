/**
 * Pure scale metadata and USB-setting helpers.  This module deliberately has
 * no DOM or application imports so the socket/cache policy can be tested in
 * Node and reused by settings integrations.
 */

export function getScaleDeviceSetting(settings, key, deviceId) {
    if (!Object.prototype.hasOwnProperty.call(settings || {}, key)) return undefined;
    return settings?.[key]?.[deviceId] === true;
}

export function hasSkaleUsbSetting(settings, device) {
    const values = settings?.skalePoweredByUsbByDevice;
    return typeof device?.name === 'string' && device.name.toLowerCase().includes('skale') &&
        Object.prototype.hasOwnProperty.call(settings || {}, 'skalePoweredByUsbByDevice') &&
        values !== null && typeof values === 'object' && !Array.isArray(values);
}

export function shouldInvalidateScaleInfoAfterWrite({ reaSucceeded, usbPowerSettingsChanged }) {
    return reaSucceeded === true && usbPowerSettingsChanged === true;
}

export function createScaleInfoLifecycle({
    getScaleInfo,
    getDeviceState,
    renderDeviceListFromCache = () => {},
    logger = { warn() {} },
    isMounted = () => true,
    now = () => Date.now(),
    retryAfterMs = 30_000,
}) {
    const scaleInfoByDeviceId = new Map();
    const scaleInfoInFlight = new Map();
    const scaleInfoFailureAt = new Map();
    let generation = 0;
    let scaleInfoDeviceId = null;

    function invalidate() {
        generation += 1;
        scaleInfoByDeviceId.clear();
        scaleInfoFailureAt.clear();
        scaleInfoInFlight.clear();
    }

    async function refreshScaleInfo(connectedScaleId) {
        if (scaleInfoDeviceId !== connectedScaleId) {
            generation += 1;
            scaleInfoDeviceId = connectedScaleId;
            scaleInfoByDeviceId.clear();
            scaleInfoFailureAt.clear();
            scaleInfoInFlight.clear();
        }
        if (!connectedScaleId || !isMounted()) return;
        const failedAt = scaleInfoFailureAt.get(connectedScaleId);
        if (failedAt !== undefined && now() - failedAt < retryAfterMs) return;
        if (failedAt !== undefined) {
            scaleInfoFailureAt.delete(connectedScaleId);
            scaleInfoByDeviceId.delete(connectedScaleId);
        }
        if (scaleInfoByDeviceId.has(connectedScaleId) || scaleInfoInFlight.has(connectedScaleId)) return;
        const requestGeneration = generation;
        const request = getScaleInfo();
        scaleInfoInFlight.set(connectedScaleId, request);
        try {
            const info = await request;
            const devices = getDeviceState()?.devices || [];
            if (requestGeneration !== generation || scaleInfoDeviceId !== connectedScaleId ||
                !devices.some(device => device.id === connectedScaleId &&
                    device.state === 'connected' && device.available !== false)) return;
            scaleInfoFailureAt.delete(connectedScaleId);
            scaleInfoByDeviceId.set(connectedScaleId, info || {});
            renderDeviceListFromCache();
        } catch (error) {
            if (requestGeneration === generation && scaleInfoDeviceId === connectedScaleId) {
                // Cache every failure, including network/500 failures.  The
                // settings page can receive frequent WS frames while a host
                // is offline; a bounded retry prevents an error storm.
                scaleInfoFailureAt.set(connectedScaleId, now());
                scaleInfoByDeviceId.set(connectedScaleId, {});
                if (![404, 405, 501, 503].includes(error?.status)) {
                    logger.warn(`Could not load scale info for ${connectedScaleId}:`, error);
                }
            }
        } finally {
            if (scaleInfoInFlight.get(connectedScaleId) === request) {
                scaleInfoInFlight.delete(connectedScaleId);
            }
        }
    }

    return {
        refreshScaleInfo,
        invalidate,
        scaleInfoByDeviceId,
        scaleInfoInFlight,
        get generation() { return generation; },
    };
}
