'use strict';

/**
 * Integration tests — require a real VNC server and/or a real AI API.
 *
 * Set these environment variables to activate each test:
 *
 *   VNC_HOST      VNC server hostname  (activates VNC tests)
 *   VNC_PORT      VNC server port      (default: 5900)
 *   VNC_PASSWORD  VNC password         (optional)
 *
 *   AI_BASE_URL   OpenAI-compatible API base URL  (activates AI tests)
 *                 e.g. http://localhost:11434/v1
 *   AI_API_KEY    API key              (default: 'no-key')
 *   AI_MODEL      Model name           (default: 'llava')
 *
 * When neither VNC_HOST nor AI_BASE_URL is set, all tests are skipped.
 *
 * Run:
 *   VNC_HOST=192.168.1.10 AI_BASE_URL=http://localhost:11434/v1 npm run test:integration
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { Agent }    = require('../lib/agent');
const { AIClient } = require('../lib/ai');

const VNC_HOST     = process.env.VNC_HOST     || null;
const VNC_PORT     = parseInt(process.env.VNC_PORT || '5900', 10);
const VNC_PASSWORD = process.env.VNC_PASSWORD || null;

const AI_BASE_URL  = process.env.AI_BASE_URL  || null;
const AI_API_KEY   = process.env.AI_API_KEY   || 'no-key';
const AI_MODEL     = process.env.AI_MODEL     || 'llava';

// ── VNC-only test ─────────────────────────────────────────────────────────────

test('integration/vnc: connect and take a screenshot',
  { skip: VNC_HOST ? false : 'Set VNC_HOST env var to run' },
  async () => {
    const agent = new Agent({
      vnc: { host: VNC_HOST, port: VNC_PORT, password: VNC_PASSWORD },
      ai:  { baseUrl: AI_BASE_URL || 'http://localhost/v1' },
    });

    await agent.connect();
    try {
      const png = await agent._vnc.screenshot();
      assert.ok(png instanceof Buffer, 'screenshot should be a Buffer');
      assert.equal(png[0], 137, 'should contain PNG signature byte 0');
      assert.equal(png[1],  80, 'should contain PNG signature byte 1 (P)');
      assert.equal(png[2],  78, 'should contain PNG signature byte 2 (N)');
      assert.equal(png[3],  71, 'should contain PNG signature byte 3 (G)');
      assert.ok(png.length > 500, 'PNG should be a reasonable size');
    } finally {
      await agent.disconnect();
    }
  },
);

// ── AI-only test ──────────────────────────────────────────────────────────────

test('integration/ai: API responds to a text message',
  { skip: AI_BASE_URL ? false : 'Set AI_BASE_URL env var to run' },
  async () => {
    const ai     = new AIClient({ baseUrl: AI_BASE_URL, apiKey: AI_API_KEY, model: AI_MODEL });
    const result = await ai.chat(
      [{ role: 'user', content: 'Reply with exactly the JSON: [{"cmd":"screenshot"}]' }],
      { max_tokens: 64 },
    );
    assert.ok(typeof result === 'string' && result.length > 0, 'should receive a non-empty response');
  },
);

// ── Full agent test ───────────────────────────────────────────────────────────

test('integration/agent: run a task end-to-end',
  { skip: (VNC_HOST && AI_BASE_URL) ? false : 'Set VNC_HOST and AI_BASE_URL env vars to run' },
  async () => {
    const agent = new Agent({
      vnc:      { host: VNC_HOST, port: VNC_PORT, password: VNC_PASSWORD },
      ai:       { baseUrl: AI_BASE_URL, apiKey: AI_API_KEY, model: AI_MODEL },
      maxSteps: 3,
    });

    const steps = [];
    await agent.connect();
    try {
      const result = await agent.run('Take a screenshot and tell me what you see', {
        onStep: (step, actions) => { steps.push({ step, actions }); },
      });
      assert.ok(result.steps >= 1, 'should have taken at least one step');
      assert.ok(typeof result.result === 'string', 'result should be a string');
    } finally {
      await agent.disconnect();
    }
  },
);
