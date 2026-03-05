'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { parseResponse } = require('../lib/agent');

test('parseResponse: parses a JSON array', () => {
  const result = parseResponse('[{"cmd":"click"}]');
  assert.deepEqual(result, [{ cmd: 'click' }]);
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
  const text   = 'I will click the button: [{"cmd":"click"}]';
  const result = parseResponse(text);
  assert.deepEqual(result, [{ cmd: 'click' }]);
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

test('parseResponse: handles scroll with h/v fields', () => {
  const text = 'Scroll down:\n{"cmd":"scroll","v":5}';
  const result = parseResponse(text);
  assert.deepEqual(result, [{ cmd: 'scroll', v: 5 }]);
});


test('parseResponse: extracts single action from reasoning text', () => {
  const text = 'OBSERVE: I see settings.\nPLAN: Click it.\nACT: {"cmd":"click"}\nEXPECT: Opens settings.';
  const result = parseResponse(text);
  assert.deepEqual(result, [{ cmd: 'click' }]);
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
  const text = 'Here are the actions:\n```json\n[{"cmd":"click"}]\n```\nSome text after.';
  const result = parseResponse(text);
  assert.deepEqual(result, [{ cmd: 'click' }]);
});

// ── New tests for VNC efficiency features ─────────────────────────────────

const { Agent } = require('../lib/agent');
const { encodePNG } = require('vnc-tool/lib/png');

// helper to create a raw RGBA buffer of given dimensions
function makeRaw(w, h, fill = 0) {
  const buf = Buffer.alloc(w * h * 4);
  buf.fill(fill);
  return buf;
}

test('Agent.screenshotRaw returns underlying framebuffer when available', async () => {
  const agent = new Agent();
  const rawBuf = Buffer.from([1,2,3,4,5,6,7,8]);
  agent._vnc = { width: 2, height: 1 };
  agent._screenBuffer = {
    captureScreen: () => ({ width: 2, height: 1, rgba: rawBuf })
  };
  const r = await agent.screenshotRaw();
  assert.deepEqual(r, { width: 2, height: 1, rgba: rawBuf });
});

test('Agent.screenshotRaw falls back to decoding PNG when no raw buffer', async () => {
  const agent = new Agent();
  const raw = makeRaw(2,1);
  let saw = false;
  agent._vnc = {
    width: 2, height: 1,
    screenshot: async () => { saw = true; return encodePNG(2,1,raw); }
  };
  agent._screenBuffer = null; // no screen buffer available
  const r = await agent.screenshotRaw();
  assert.ok(saw, 'screenshot() should have been called');
  assert.deepEqual(r, { width: 2, height: 1, rgba: raw });
});

test('Agent.waitForScreenChange returns quickly when updateCount moves and never screenshots', async () => {
  const agent = new Agent();
  let called = 0;
  agent._vnc = {
    screenshot: async () => { called++; return Buffer.from('A'); }
  };
  agent._screenBuffer = { updateCount: 0 };
  // bump updateCount after a short delay so waitForScreenChange exits early
  setTimeout(() => { agent._screenBuffer.updateCount = 5; }, 50);

  const result = await agent.waitForScreenChange({ maxWait: 500, pollInterval: 20 });
  assert.equal(result.changed, true);
  assert.equal(called, 0, 'should not take any screenshots');
});

test('Agent.waitForScreenChange times out and returns false when no updates', async () => {
  const agent = new Agent();
  let called = 0;
  agent._vnc = {
    screenshot: async () => { called++; return Buffer.from('same'); }
  };
  agent._screenBuffer = { updateCount: 0 };

  const result = await agent.waitForScreenChange({ maxWait: 100, pollInterval: 20 });
  assert.equal(result.changed, false);
  assert.equal(called, 0, 'should not take any screenshots');
});

// ── Agent.run behaviour tests ────────────────────────────────────────────────

test('Agent.run stops when AI signals done and returns result', async () => {
  const agent = new Agent();
  const raw = makeRaw(1, 1);
  agent._vnc = {
    width: 1, height: 1,
    screenshot: async () => encodePNG(1, 1, raw),
  };
  agent._screenBuffer = {
    captureScreen: () => ({ width: 1, height: 1, rgba: raw }),
    updateCount: 0,
  };
  let chatCalls = 0;
  agent.chat = async () => {
    chatCalls++;
    return JSON.stringify({ done: true, result: 'completed' });
  };
  agent.execute = async () => {};

  const res = await agent.run('whatever', { maxSteps: 5, onStep: () => { throw new Error('should not call'); } });
  assert.equal(res.steps, 1);
  assert.equal(res.result, 'completed');
});

test('Agent.run invokes onStep for each step with actions', async () => {
  const agent = new Agent();
  const raw = makeRaw(1, 1);
  agent._vnc = {
    width: 1, height: 1,
    screenshot: async () => encodePNG(1, 1, raw),
  };
  agent._screenBuffer = {
    captureScreen: () => ({ width: 1, height: 1, rgba: raw }),
    updateCount: 0,
  };
  // first call returns an action, second call signals done
  let chatCalls = 0;
  agent.chat = async () => {
    chatCalls++;
    if (chatCalls === 1) return JSON.stringify([{ cmd: 'click', x: 0, y: 0 }]);
    return JSON.stringify({ done: true, result: 'done' });
  };
  agent.execute = async () => {};

  const steps = [];
  const res = await agent.run('test', { maxSteps: 3, onStep: (s, actions) => steps.push({ s, actions }) });
  assert.equal(res.result, 'done');
  assert.equal(steps.length, 1, 'one onStep callback should have been invoked');
  assert.equal(steps[0].s, 1);
  assert.deepEqual(steps[0].actions, [{ cmd: 'click', x: 0, y: 0 }]);
});

// new behaviour: fail early when no screenshot is available

test('Agent.run throws if screenshotRaw returns null', async () => {
  const agent = new Agent();
  // stub screenshotRaw to simulate a fatal VNC failure
  agent.screenshotRaw = async () => null;
  agent._vnc = { width: 1, height: 1 };
  agent._screenBuffer = null;
  agent.chat = async () => { throw new Error('chat should not be called'); };
  await assert.rejects(
    agent.run('whatever'),
    /Unable to capture screenshot/,
  );
});

// ── Logging behaviour tests ───────────────────────────────────────────────

test('Agent.run does not print step summary when verbose=0', async () => {
  const agent = new Agent(); // default verbose 0
  const raw = makeRaw(1, 1);
  agent._vnc = {
    width: 1, height: 1,
    screenshot: async () => encodePNG(1, 1, raw),
  };
  agent._screenBuffer = {
    captureScreen: () => ({ width: 1, height: 1, rgba: raw }),
    updateCount: 0,
  };
  let chatCalls = 0;
  agent.chat = async () => {
    chatCalls++;
    if (chatCalls === 1) return JSON.stringify([{ cmd: 'click', x: 0, y: 0 }]);
    return JSON.stringify({ done: true, result: 'done' });
  };
  agent.execute = async () => {};

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  await agent.run('test', { maxSteps: 2 });

  console.log = origLog;
  assert.equal(logs.some(l => l.includes('Step 1')), false, 'should not log step summary by default');
});

test('Agent.run prints step summary when verbose>=1', async () => {
  const agent = new Agent({ verbose: 1 });
  const raw = makeRaw(1, 1);
  agent._vnc = {
    width: 1, height: 1,
    screenshot: async () => encodePNG(1, 1, raw),
  };
  agent._screenBuffer = {
    captureScreen: () => ({ width: 1, height: 1, rgba: raw }),
    updateCount: 0,
  };
  let chatCalls = 0;
  agent.chat = async () => {
    chatCalls++;
    if (chatCalls === 1) return JSON.stringify([{ cmd: 'click', x: 0, y: 0 }]);
    return JSON.stringify({ done: true, result: 'done' });
  };
  agent.execute = async () => {};

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  await agent.run('test', { maxSteps: 2 });

  console.log = origLog;
  assert.ok(logs.some(l => l.includes('Step 1')), 'should log step summary when verbose');
});
