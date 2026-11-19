import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/modules/api.js', import.meta.url), 'utf8');
const match = source.match(/export function sendDeviceCommand\(command\) \{[\s\S]*?\r?\n\}/);
assert.ok(match);
const functionSource = match[0].replace('export ', '');

const loadSendDeviceCommand = (deviceWebSocket) => new Function(
    'deviceWebSocket',
    'WebSocket',
    'logger',
    `${functionSource}\nreturn sendDeviceCommand;`,
)(deviceWebSocket, { OPEN: 1 }, { error() {}, info() {} });

test('device commands reject an unavailable socket and send through an open socket', () => {
    const command = { command: 'scan', connect: true };
    assert.throws(
        () => loadSendDeviceCommand(null)(command),
        /Device WebSocket is not connected/,
    );

    let payload;
    loadSendDeviceCommand({
        readyState: 1,
        send: (value) => { payload = value; },
    })(command);
    assert.equal(payload, JSON.stringify(command));
});

const stateMatch = source.match(/export async function setMachineState\(newState\) \{[\s\S]*?\r?\n\}/);
assert.ok(stateMatch);

const loadSetMachineState = (fetchImpl) => {
    const toasts = [];
    const setMachineState = new Function(
        'fetch',
        'ui',
        'API_BASE_URL',
        `${stateMatch[0].replace('export ', '')}\nreturn setMachineState;`,
    )(fetchImpl, { showToast: (...args) => toasts.push(args) }, 'http://machine');
    return { setMachineState, toasts };
};

test('a machine command that cannot reach Decaid says so once and still rejects', async () => {
    const networkError = new TypeError('Failed to fetch');
    const { setMachineState, toasts } = loadSetMachineState(async () => { throw networkError; });
    await assert.rejects(setMachineState('espresso'), networkError);
    assert.deepEqual(toasts, [['Disconnected', 4000, 'error']]);
});

test('a shot blocked for having no scale tells the user why and still rejects', async () => {
    const { setMachineState, toasts } = loadSetMachineState(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ type: 'block_no_scale', details: 'No scale detected, blocking espresso request' }),
    }));
    await assert.rejects(setMachineState('espresso'), /Failed to set machine state to espresso/);
    assert.deepEqual(toasts, [['No scale connected — shot blocked', 4000, 'error']]);
});

test('any other 400, readable or not, stays quiet', async () => {
    for (const json of [async () => ({ type: 'other' }), async () => { throw new SyntaxError('not json'); }]) {
        const { setMachineState, toasts } = loadSetMachineState(async () => ({ ok: false, status: 400, json }));
        await assert.rejects(setMachineState('espresso'), /Failed to set machine state to espresso/);
        assert.deepEqual(toasts, []);
    }
});

test('a machine command Decaid refuses rejects without claiming a disconnect', async () => {
    const { setMachineState, toasts } = loadSetMachineState(async () => ({ ok: false }));
    await assert.rejects(setMachineState('espresso'), /Failed to set machine state to espresso/);
    assert.deepEqual(toasts, []);
});
