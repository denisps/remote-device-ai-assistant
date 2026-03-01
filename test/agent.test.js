'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { parseResponse } = require('../lib/agent');

test('parseResponse: parses a JSON array', () => {
  const result = parseResponse('[{"cmd":"click","x":100,"y":200}]');
  assert.deepEqual(result, [{ cmd: 'click', x: 100, y: 200 }]);
});

test('parseResponse: parses a done object', () => {
  const result = parseResponse('{"done":true,"result":"Task complete"}');
  assert.deepEqual(result, { done: true, result: 'Task complete' });
});

test('parseResponse: parses a done object without result field', () => {
  const result = parseResponse('{"done":true}');
  assert.deepEqual(result, { done: true });
});

test('parseResponse: extracts JSON from markdown json fence', () => {
  const text   = 'Here are the actions:\n```json\n[{"cmd":"screenshot"}]\n```';
  const result = parseResponse(text);
  assert.deepEqual(result, [{ cmd: 'screenshot' }]);
});

test('parseResponse: extracts JSON from plain markdown fence', () => {
  const text   = 'Actions:\n```\n[{"cmd":"type","text":"hi"}]\n```';
  const result = parseResponse(text);
  assert.deepEqual(result, [{ cmd: 'type', text: 'hi' }]);
});

test('parseResponse: extracts JSON array embedded in prose', () => {
  const text   = 'I will click the button: [{"cmd":"click","x":50,"y":50}]';
  const result = parseResponse(text);
  assert.deepEqual(result, [{ cmd: 'click', x: 50, y: 50 }]);
});

test('parseResponse: extracts JSON object embedded in prose', () => {
  const text   = 'The task is done! {"done":true,"result":"opened terminal"}';
  const result = parseResponse(text);
  assert.deepEqual(result, { done: true, result: 'opened terminal' });
});

test('parseResponse: throws on completely non-JSON response', () => {
  assert.throws(
    () => parseResponse('This is just plain text with no JSON at all.'),
    /Could not parse AI response/,
  );
});

test('parseResponse: throws on empty string', () => {
  assert.throws(
    () => parseResponse(''),
    /Empty AI response/,
  );
});

test('parseResponse: handles multiple actions in array', () => {
  const actions = [
    { cmd: 'move', x: 200, y: 300 },
    { cmd: 'click', x: 200, y: 300 },
    { cmd: 'type', text: 'hello' },
    { cmd: 'key', combo: 'Return' },
  ];
  const result = parseResponse(JSON.stringify(actions));
  assert.deepEqual(result, actions);
});

// ── New: extract JSON from reasoning text ─────────────────────────────────────

test('parseResponse: extracts single action from reasoning text', () => {
  const text = 'OBSERVE: I see settings.\nPLAN: Click it.\nACT: {"cmd":"click","x":500,"y":250}\nEXPECT: Opens settings.';
  const result = parseResponse(text);
  assert.deepEqual(result, [{ cmd: 'click', x: 500, y: 250 }]);
});

test('parseResponse: extracts multiple actions from reasoning text', () => {
  const text = 'I will type then press enter.\n{"cmd":"type","text":"hello"}\n{"cmd":"key","combo":"Return"}';
  const result = parseResponse(text);
  assert.deepEqual(result, [{ cmd: 'type', text: 'hello' }, { cmd: 'key', combo: 'Return' }]);
});

test('parseResponse: extracts done signal from reasoning text', () => {
  const text = 'The wallpaper is set. The task is complete.\n{"done":true,"result":"Blue sky wallpaper applied"}';
  const result = parseResponse(text);
  assert.deepEqual(result, { done: true, result: 'Blue sky wallpaper applied' });
});

test('parseResponse: prefers fenced code block over inline', () => {
  const text = 'Here are the actions:\n```json\n[{"cmd":"click","x":10,"y":20}]\n```\nSome text after.';
  const result = parseResponse(text);
  assert.deepEqual(result, [{ cmd: 'click', x: 10, y: 20 }]);
});
