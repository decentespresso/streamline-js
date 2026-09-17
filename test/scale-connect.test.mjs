import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync('src/modules/api.js', 'utf8');
const match = source.match(/export async function connectScaleDevice\(\) \{[\s\S]*?\n\}/);

test('scale connection preserves the original fetch failure', async () => {
    assert.ok(match);
    const failure = new Error('offline');
    const connect = new Function('fetch', 'API_BASE_URL', 'logger', `${match[0].replace('export ', '')}; return connectScaleDevice;`)(
        async () => { throw failure; },
        'http://localhost',
        { info() {}, error() {} },
    );
    await assert.rejects(connect(), error => error === failure);
});

// app.js touches window/document at module load, so scaleAutoRetryDecision is
// pulled out by text and evaluated, same idiom as connectScaleDevice above.
const appSource = readFileSync('src/modules/app.js', 'utf8');
const decisionMatch = appSource.match(/export function scaleAutoRetryDecision\(\{[\s\S]*?\n\}\)\s*\{[\s\S]*?\n\}/);
assert.ok(decisionMatch, 'scaleAutoRetryDecision not found in app.js');
const scaleAutoRetryDecision = new Function(`${decisionMatch[0].replace('export ', '')}; return scaleAutoRetryDecision;`)();

const baseArgs = {
    scaleConnected: false,
    retryCount: 0,
    maxRetries: 3,
    hasScaleId: true,
    powerMode: 'displayOff',
    machineAsleep: false,
    inWakeGrace: false,
    hostScanning: false,
    waitCount: 0,
    maxWaits: 6,
};

test('scaleAutoRetryDecision stops when the machine is asleep (the reported bug)', () => {
    assert.equal(scaleAutoRetryDecision({ ...baseArgs, machineAsleep: true }), 'stop');
});

test('scaleAutoRetryDecision waits (without burning a retry slot) during the wake grace window', () => {
    const decision = scaleAutoRetryDecision({ ...baseArgs, inWakeGrace: true });
    assert.equal(decision, 'wait');
    assert.notEqual(decision, 'retry');
});

test('scaleAutoRetryDecision waits when the host is already scanning', () => {
    assert.equal(scaleAutoRetryDecision({ ...baseArgs, hostScanning: true }), 'wait');
});

test('scaleAutoRetryDecision stops when scalePowerMode is disconnect', () => {
    assert.equal(scaleAutoRetryDecision({ ...baseArgs, powerMode: 'disconnect' }), 'stop');
});

test('scaleAutoRetryDecision stops once the retry budget is exhausted', () => {
    assert.equal(scaleAutoRetryDecision({ ...baseArgs, retryCount: 3, maxRetries: 3 }), 'stop');
});

test('scaleAutoRetryDecision stops when there is no saved scale id', () => {
    assert.equal(scaleAutoRetryDecision({ ...baseArgs, hasScaleId: false }), 'stop');
});

test('scaleAutoRetryDecision stops when the scale is already connected', () => {
    assert.equal(scaleAutoRetryDecision({ ...baseArgs, scaleConnected: true }), 'stop');
});

test('scaleAutoRetryDecision retries when awake, idle, and budget remains', () => {
    assert.equal(scaleAutoRetryDecision(baseArgs), 'retry');
});

test('scaleAutoRetryDecision stops once the wait budget is exhausted', () => {
    assert.equal(scaleAutoRetryDecision({ ...baseArgs, hostScanning: true, waitCount: 6, maxWaits: 6 }), 'stop');
});

test('scaleAutoRetryDecision still waits when wait budget remains', () => {
    assert.equal(scaleAutoRetryDecision({ ...baseArgs, hostScanning: true, waitCount: 5, maxWaits: 6 }), 'wait');
});
