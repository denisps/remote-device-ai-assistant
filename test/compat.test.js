'use strict';

/**
 * AI model compatibility tests.
 *
 * These tests check whether the configured model can handle the tasks
 * required by the VNC assistant: vision, JSON output, action formatting,
 * tool calling, UI identification, and prompt customisation.
 *
 * All tests are skipped unless AI_BASE_URL is set.
 *
 * Run:
 *   AI_BASE_URL=http://localhost:11434/v1 AI_MODEL=llava npm run test:compat
 *
 * Optional variables:
 *   AI_API_KEY   API key             (default: 'no-key')
 *   AI_MODEL     Model name          (default: 'llava')
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { AIClient }                          = require('../lib/ai');
const { parseResponse }                     = require('../lib/agent');
const { SYSTEM_PROMPT, createSystemPrompt } = require('../lib/prompts');
const { encodePNG }                         = require('vnc-tool/lib/png');

const AI_BASE_URL = process.env.AI_BASE_URL || null;
const AI_API_KEY  = process.env.AI_API_KEY  || 'no-key';
const AI_MODEL    = process.env.AI_MODEL    || 'llava';

const SKIP = AI_BASE_URL ? false : 'Set AI_BASE_URL env var to run';

function makeClient() {
  return new AIClient({ baseUrl: AI_BASE_URL, apiKey: AI_API_KEY, model: AI_MODEL });
}

/** Create a solid-colour PNG image for use as a test input. */
function solidColorPng(width, height, r, g, b) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4]     = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return encodePNG(width, height, rgba);
}

// ── 1. Text response ──────────────────────────────────────────────────────────

test('compat/text: model responds to a basic text prompt',
  { skip: SKIP },
  async () => {
    const ai    = makeClient();
    const reply = await ai.chat(
      [{ role: 'user', content: 'Say the word hello.' }],
      { max_tokens: 30 },
    );
    assert.ok(typeof reply === 'string' && reply.length > 0, 'should return non-empty text');
  },
);

// ── 2. Vision support ─────────────────────────────────────────────────────────

test('compat/vision: model identifies the dominant colour of a solid-colour image',
  { skip: SKIP },
  async () => {
    const ai  = makeClient();
    const png = solidColorPng(64, 64, 220, 20, 20); // solid red

    const reply = await ai.chat(
      [ai.buildImageMessage(png, 'What is the dominant color of this image? Reply with just the color name.')],
      { max_tokens: 20 },
    );

    assert.ok(typeof reply === 'string' && reply.length > 0, 'should return a color description');
    assert.ok(
      /red|crimson|scarlet/i.test(reply),
      `expected a red-like color name, got: "${reply.trim().slice(0, 80)}"`,
    );
  },
);

// ── 3. JSON output compliance ─────────────────────────────────────────────────

test('compat/json-output: model follows a JSON-only system instruction',
  { skip: SKIP },
  async () => {
    const ai = makeClient();
    const reply = await ai.chat([
      { role: 'system', content: 'Reply ONLY with valid JSON. No prose, no markdown.' },
      { role: 'user',   content: 'Return a JSON object with a single key "status" set to "ok".' },
    ], { max_tokens: 30 });

    let parsed;
    try {
      parsed = JSON.parse(reply.trim());
    } catch (_) {
      assert.fail(`Response is not valid JSON: "${reply.trim().slice(0, 80)}"`);
    }
    assert.ok(typeof parsed === 'object' && parsed !== null, 'response should be a JSON object');
  },
);

// ── 4. VNC action format ──────────────────────────────────────────────────────

test('compat/action-format: model produces parseable VNC action commands',
  { skip: SKIP },
  async () => {
    const ai  = makeClient();
    // A plain desktop-coloured image as a stand-in for a screenshot
    const png = solidColorPng(320, 240, 40, 60, 100);

    const reply = await ai.chat([
      { role: 'system', content: SYSTEM_PROMPT },
      ai.buildImageMessage(
        png,
        'Task: Take a screenshot of the current screen.\n\n' +
        'Look at the screenshot and respond with the first actions to take.',
      ),
    ], { max_tokens: 200 });

    let actions;
    try {
      actions = parseResponse(reply);
    } catch (_) {
      assert.fail(`parseResponse failed on: "${reply.slice(0, 120)}"`);
    }

    if (Array.isArray(actions)) {
      assert.ok(actions.length > 0, 'action array should not be empty');
      for (const action of actions) {
        assert.ok(
          typeof action.cmd === 'string',
          `each action needs a "cmd" field, got: ${JSON.stringify(action)}`,
        );
      }
    } else {
      // A done object is also a valid response
      assert.ok(actions.done === true, 'non-array response should be a done object');
    }
  },
);

// ── 5. Tool calling ───────────────────────────────────────────────────────────

test('compat/tool-calling: model handles a function/tool definition',
  { skip: SKIP },
  async () => {
    const ai    = makeClient();
    const tools = [
      {
        type: 'function',
        function: {
          name:        'take_screenshot',
          description: 'Capture the current screen and return a PNG image.',
          parameters:  { type: 'object', properties: {} },
        },
      },
    ];

    let message;
    try {
      message = await ai.chat(
        [{ role: 'user', content: 'Take a screenshot of the current screen.' }],
        { tools, tool_choice: 'auto', raw: true, max_tokens: 100 },
      );
    } catch (e) {
      assert.fail(`API returned an error when tools were provided: ${e.message}`);
    }

    const hasContent   = typeof message.content === 'string' && message.content.length > 0;
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

    assert.ok(
      hasContent || hasToolCalls,
      'model should respond with either content or tool_calls when tools are provided',
    );

    if (hasToolCalls) {
      // If the model chose to use a tool, verify it called the right one
      assert.equal(
        message.tool_calls[0].function.name,
        'take_screenshot',
        'tool call should reference the defined function',
      );
    }
    // hasToolCalls === false means the model does not support tool calling —
    // the test still passes as long as the model gives some response.
  },
);

// ── 6. UI / OS identification ─────────────────────────────────────────────────

test('compat/ui-identification: model can describe a screenshot',
  { skip: SKIP },
  async () => {
    const ai = makeClient();
    // Gradient image that loosely resembles a desktop background
    const w = 320, h = 240;
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i]     = Math.floor(30  + y * 0.4);
        rgba[i + 1] = Math.floor(50  + y * 0.5);
        rgba[i + 2] = Math.floor(80  + y * 0.6);
        rgba[i + 3] = 255;
      }
    }
    const png = encodePNG(w, h, rgba);

    const reply = await ai.chat([
      ai.buildImageMessage(
        png,
        'Describe what you see in this screenshot in one sentence.',
      ),
    ], { max_tokens: 80 });

    assert.ok(typeof reply === 'string' && reply.length > 10, 'should return a description');
  },
);

// ── 7. Prompt customisation ───────────────────────────────────────────────────

test('compat/prompt-customization: model adapts its response to extra context',
  { skip: SKIP },
  async () => {
    const ai = makeClient();

    const macPrompt = createSystemPrompt({ extraContext: 'The remote device is running macOS.' });
    const winPrompt = createSystemPrompt({ extraContext: 'The remote device is running Windows 11.' });

    const question = [
      { role: 'user', content: 'How do I open the Settings application? Give a one-sentence answer.' },
    ];

    const macReply = await ai.chat(
      [{ role: 'system', content: macPrompt }, ...question],
      { max_tokens: 80 },
    );
    const winReply = await ai.chat(
      [{ role: 'system', content: winPrompt }, ...question],
      { max_tokens: 80 },
    );

    assert.ok(typeof macReply === 'string' && macReply.length > 0, 'macOS reply should be non-empty');
    assert.ok(typeof winReply === 'string' && winReply.length > 0, 'Windows reply should be non-empty');
    assert.notEqual(
      macReply.trim(),
      winReply.trim(),
      'responses for different OS contexts should differ',
    );
  },
);
