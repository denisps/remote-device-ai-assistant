'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { SYSTEM_PROMPT, buildTaskMessage, createSystemPrompt } = require('../lib/prompts');

test('SYSTEM_PROMPT: contains all action names', () => {
  for (const action of ['click', 'type', 'key', 'move', 'scroll', 'delay']) {
    assert.ok(SYSTEM_PROMPT.includes(`"cmd":"${action}"`), `missing action: ${action}`);
  }
});

test('SYSTEM_PROMPT: instructs the model to use JSON', () => {
  assert.ok(SYSTEM_PROMPT.includes('JSON'));
});

test('SYSTEM_PROMPT: describes the done signal', () => {
  assert.ok(SYSTEM_PROMPT.includes('"done":true'));
});

test('buildTaskMessage: step 1 mentions the task', () => {
  const msg = buildTaskMessage('Open a browser', 1);
  assert.ok(msg.includes('Open a browser'));
  assert.ok(msg.includes('Task:'));
});

test('buildTaskMessage: step 1 does not show a step number', () => {
  const msg = buildTaskMessage('Open a browser', 1);
  assert.ok(!msg.includes('Step 1'));
});

test('buildTaskMessage: step 2+ shows the step number', () => {
  const msg = buildTaskMessage('Open a browser', 2);
  assert.ok(msg.includes('Step 2'));
  assert.ok(msg.includes('Open a browser'));
});

test('buildTaskMessage: step 2+ includes done instruction', () => {
  const msg = buildTaskMessage('do something', 3);
  assert.ok(msg.includes('done'));
});

test('buildTaskMessage: defaults to step 1', () => {
  const withDefault  = buildTaskMessage('task');
  const withExplicit = buildTaskMessage('task', 1);
  assert.equal(withDefault, withExplicit);
});

test('createSystemPrompt: without options returns the default prompt', () => {
  assert.equal(createSystemPrompt(), SYSTEM_PROMPT);
});

test('createSystemPrompt: appends extraContext', () => {
  const prompt = createSystemPrompt({ extraContext: 'This is Windows 11' });
  assert.ok(prompt.includes('This is Windows 11'));
  assert.ok(prompt.startsWith(SYSTEM_PROMPT));
});

test('createSystemPrompt: appends language instruction', () => {
  const prompt = createSystemPrompt({ language: 'fr' });
  assert.ok(prompt.includes('fr'));
});

test('createSystemPrompt: does not add language for "en"', () => {
  const prompt = createSystemPrompt({ language: 'en' });
  assert.equal(prompt, SYSTEM_PROMPT);
});
