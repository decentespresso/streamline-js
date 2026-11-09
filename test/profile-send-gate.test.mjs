import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    PROFILE_SEND_BLOCKING_STATES, profileSendBlocked, shouldFlushPendingSend,
    setPendingProfileSend, peekPendingProfileSend, takePendingProfileSend, clearPendingProfileSend,
} from '../src/modules/profile-send-gate.js';
import { profileSwitchDial } from '../src/modules/profile-overrides.js';

const record = (over = {}) => ({
    id: 'A', profile: { title: 'Londinium', target_weight: '36' }, metadata: {}, ...over,
});

test('only espresso blocks a profile send', () => {
    assert.deepEqual(PROFILE_SEND_BLOCKING_STATES, ['espresso']);
    assert.equal(profileSendBlocked('espresso'), true);
    // These run no profile frames, so the frame table is not in use.
    for (const state of ['idle', 'steam', 'flush', 'hotWater', 'steamRinse', 'heating', 'sleeping', 'cleaning']) {
        assert.equal(profileSendBlocked(state), false, state);
    }
    // Unknown state means the snapshot socket is down, which is not a machine
    // mid-shot; blocking there would disable profile switching outright.
    for (const state of [null, undefined, '', 0, {}, 'ESPRESSO']) {
        assert.equal(profileSendBlocked(state), false, String(state));
    }
});

test('a held profile is flushed on leaving espresso, and only then', () => {
    assert.equal(shouldFlushPendingSend('espresso', 'idle'), true);
    assert.equal(shouldFlushPendingSend('espresso', 'steam'), true);
    assert.equal(shouldFlushPendingSend('espresso', null), true);
    assert.equal(shouldFlushPendingSend('espresso', 'espresso'), false);
    // Arriving at idle from anywhere else is not the end of a shot.
    assert.equal(shouldFlushPendingSend('idle', 'idle'), false);
    assert.equal(shouldFlushPendingSend('steam', 'idle'), false);
    assert.equal(shouldFlushPendingSend(null, 'idle'), false);
});

test('the pending slot holds one profile, last write wins', () => {
    clearPendingProfileSend();
    assert.equal(peekPendingProfileSend(), null);

    const a = record({ id: 'a' }), b = record({ id: 'b' });
    setPendingProfileSend(a);
    setPendingProfileSend(b);
    // Picking A then B during one shot must leave B on the machine -- not a
    // queue replaying switches the user already changed their mind about.
    assert.equal(peekPendingProfileSend(), b);

    assert.equal(takePendingProfileSend(), b);
    assert.equal(peekPendingProfileSend(), null, 'taking clears the slot');
    assert.equal(takePendingProfileSend(), null, 'and does not hand it out twice');

    // Nothing sendable is nothing held, so a flush has no reason to run.
    for (const junk of [null, undefined, {}, { id: 'x' }, { profile: null }]) {
        setPendingProfileSend(a);
        assert.equal(setPendingProfileSend(junk), null, String(junk));
        assert.equal(peekPendingProfileSend(), null);
    }

    setPendingProfileSend(a);
    clearPendingProfileSend();
    assert.equal(peekPendingProfileSend(), null);
});

// --- the one send every entry point goes through -------------------------
// Lifted out of profileManager.js, which touches the DOM at module load.
const pmSource = readFileSync(new URL('../src/modules/profileManager.js', import.meta.url), 'utf8');
const sendMatch = pmSource.match(/export async function sendProfileRecordToMachine\([\s\S]*?\n\}/);
assert.ok(sendMatch, 'sendProfileRecordToMachine not found in profileManager.js');
const sendSource = sendMatch[0]
    .replace('export async function', 'async function')
    .replace("await import('./api.js')", 'deps');

function canonicalSend({ state = 'idle', fail = false } = {}) {
    const sent = [], bound = [], warned = [];
    const deps = { currentMachineState: state };
    const fn = new Function('deps', 'profileSendBlocked', 'setPendingProfileSend', 'clearPendingProfileSend',
        'withSavedBrewTemp', 'updateWorkflow', 'setActiveProfile', 'profileSwitchDial',
        'logger', 'recipeIdPatch',
        `${sendSource}\nreturn sendProfileRecordToMachine;`)(
        deps, profileSendBlocked, setPendingProfileSend, clearPendingProfileSend,
        (p, meta) => (Number.isFinite(meta?.brewTemperature) ? { ...p, _temp: meta.brewTemperature } : p),
        async w => { if (fail) throw new Error('offline'); sent.push(w); },
        id => bound.push(id), profileSwitchDial,
        { warn: (...a) => warned.push(a) },
        () => ({ extras: { dye: { v: 1, recipeId: null } } }));
    return { fn, sent, bound, warned };
}

test('the canonical send holds mid-shot and sends otherwise', async () => {
    clearPendingProfileSend();
    const brewing = canonicalSend({ state: 'espresso' });
    assert.equal(await brewing.fn(record()), 'deferred');
    assert.deepEqual(brewing.sent, []);
    assert.deepEqual(brewing.bound, [], 'nothing switched, so nothing to bind');
    assert.equal(peekPendingProfileSend().id, 'A', 'held for the end of the shot');

    const idle = canonicalSend();
    assert.equal(await idle.fn(record()), 'sent');
    assert.equal(idle.sent.length, 1);
    assert.deepEqual(idle.bound, ['A']);
    assert.equal(peekPendingProfileSend(), null, 'a send that went out retires what was held');

    assert.equal(await canonicalSend().fn(null), 'failed');
    assert.equal(await canonicalSend().fn({ id: 'A' }), 'failed');
});

test('the send folds the saved dose, yield, grind and brew temp', async () => {
    const full = canonicalSend();
    await full.fn(record({ metadata: { targetDoseWeight: 20, targetYield: 42, grinderSetting: 7.5, brewTemperature: 92 } }));
    assert.deepEqual(full.sent[0].context, {
        targetDoseWeight: 20, targetYield: 42, grinderSetting: 7.5,
        extras: { dye: { v: 1, recipeId: null } },   // a profile change releases the recipe
    });
    assert.equal(full.sent[0].profile._temp, 92);
    // A non-autonomous machine stops on profile.target_weight, so a metadata
    // yield has to reach the profile copy too or the shot runs past it.
    assert.equal(full.sent[0].profile.target_weight, 42);

    // No saved dose or grind: neither is sent at all, so the deep merge leaves
    // whatever is live in place -- a dial-in another client set included (#189).
    const bare = canonicalSend();
    await bare.fn(record());
    assert.deepEqual(bare.sent[0].context, {
        targetYield: 36,
        extras: { dye: { v: 1, recipeId: null } },
    });

    const none = canonicalSend();
    await none.fn(record({ profile: { title: 'x', target_weight: 'n/a' } }));
    assert.deepEqual(none.sent[0].context, {
        targetYield: 0,
        extras: { dye: { v: 1, recipeId: null } },
    }, 'an unparsable target weight must send 0, never NaN');
    assert.equal(none.sent[0].profile.target_weight, 'n/a', 'and must not be written back onto the profile');
});

test('a failed send reports it and does not claim the machine switched', async () => {
    clearPendingProfileSend();
    const offline = canonicalSend({ fail: true });
    assert.equal(await offline.fn(record()), 'failed');
    assert.deepEqual(offline.bound, []);
    assert.equal(offline.warned.length, 1);
});
