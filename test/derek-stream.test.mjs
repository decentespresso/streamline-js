import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, buildFollowUpQuery, splitBold } from '../src/modules/derek-stream.js';

test('parseSse yields complete events and keeps the partial tail', () => {
    const { events, rest } = parseSse('event: delta\ndata: {"text":"Hi"}\n\nevent: delta\ndata: {"te');
    assert.deepEqual(events, [{ event: 'delta', data: { text: 'Hi' } }]);
    assert.equal(rest, 'event: delta\ndata: {"te');
});

test('parseSse handles CRLF and skips malformed frames', () => {
    const { events } = parseSse('event: x\r\ndata: nope\r\n\r\nevent: result\r\ndata: {"a":1}\r\n\r\n');
    assert.deepEqual(events, [{ event: 'result', data: { a: 1 } }]);
});

test('follow-up query carries shot context and the question', () => {
    const q = buildFollowUpQuery('SUMMARY', 'why sour?');
    assert.match(q, /SUMMARY/);
    assert.match(q, /Question: why sour\?/);
});

test('splitBold marks bold runs and leaves markup as plain text', () => {
    assert.deepEqual(splitBold('a **b** <i>c</i>'), [
        { text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' <i>c</i>', bold: false },
    ]);
});
