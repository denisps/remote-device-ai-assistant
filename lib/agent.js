'use strict';

const { VNCClient }   = require('vnc-tool/lib/client');
const { AIClient }    = require('./ai');
const { SYSTEM_PROMPT, buildTaskMessage } = require('./prompts');

/**
 * Parse the AI response text and return a JS value (array of actions or done-object).
 *
 * Handles:
 *  - Pure JSON string
 *  - JSON wrapped in a markdown code block
 *  - JSON embedded somewhere in a prose response
 *
 * @param {string} text
 * @returns {Array|{done: true, result?: string}}
 * @throws {Error} if no valid JSON can be found
 */
function parseResponse(text) {
  if (!text) throw new Error('Empty AI response');

  const trimmed = text.trim();

  // 1. Try direct parse
  try { return JSON.parse(trimmed); } catch (_) {}

  // 2. Markdown code block  ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch (_) {}
  }

  // 3. First JSON array or object in the text
  const inlineMatch = trimmed.match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/);
  if (inlineMatch) {
    try { return JSON.parse(inlineMatch[1]); } catch (_) {}
  }

  throw new Error(`Could not parse AI response as JSON: ${text.slice(0, 200)}`);
}

/**
 * AI agent that controls a remote desktop over VNC.
 *
 * The agent loops: take screenshot → ask AI → execute actions → repeat.
 */
class Agent {
  /**
   * @param {object}        options
   * @param {object}        options.vnc               VNC connection options
   * @param {string}        [options.vnc.host]         VNC host        (default: 'localhost')
   * @param {number}        [options.vnc.port]         VNC port        (default: 5900)
   * @param {string}        [options.vnc.password]     VNC password
   * @param {number}        [options.vnc.timeout]      Connection timeout ms
   * @param {AIClient|object} options.ai               AIClient instance or constructor options
   * @param {string}        [options.systemPrompt]     Override the default system prompt
   * @param {number}        [options.maxSteps]         Max action-cycles before giving up (default: 10)
   */
  constructor(options = {}) {
    this._vncOptions  = options.vnc   || {};
    this._ai          = options.ai instanceof AIClient ? options.ai : new AIClient(options.ai || {});
    this._systemPrompt = options.systemPrompt || SYSTEM_PROMPT;
    this._maxSteps    = options.maxSteps || 10;
    this._vnc         = null;
  }

  /** Connect to the VNC server. */
  async connect() {
    this._vnc = new VNCClient(this._vncOptions);
    await this._vnc.connect();
  }

  /** Disconnect from the VNC server. */
  async disconnect() {
    if (this._vnc) {
      await this._vnc.disconnect();
      this._vnc = null;
    }
  }

  /**
   * Run a natural-language task on the remote device.
   *
   * @param {string}   task          What to do on the remote desktop
   * @param {object}   [opts]
   * @param {Function} [opts.onStep] Called before each action set: (step, actions) => void
   * @returns {Promise<{steps: number, result: string}>}
   */
  async run(task, opts = {}) {
    if (!this._vnc) await this.connect();

    for (let step = 1; step <= this._maxSteps; step++) {
      const screenshot = await this._vnc.screenshot();

      const messages = [
        { role: 'system', content: this._systemPrompt },
        this._ai.buildImageMessage(screenshot, buildTaskMessage(task, step)),
      ];

      const responseText = await this._ai.chat(messages);
      const parsed       = parseResponse(responseText);

      if (!Array.isArray(parsed) && parsed.done === true) {
        return { steps: step, result: parsed.result || 'Done' };
      }

      const actions = Array.isArray(parsed) ? parsed : [parsed];

      if (opts.onStep) await opts.onStep(step, actions);

      await this._vnc.run(actions);
    }

    return { steps: this._maxSteps, result: 'Max steps reached' };
  }
}

module.exports = { Agent, parseResponse };
