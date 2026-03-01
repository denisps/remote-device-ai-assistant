'use strict';

const { VNCClient }   = require('vnc-tool/lib/client');
const { AIClient }    = require('./ai');
const { SYSTEM_PROMPT, buildTaskMessage } = require('./prompts');

/**
 * Attempt lightweight structural repairs on an AI-produced JSON string.
 *
 * Handles common small-model mistakes:
 *  - Unquoted keys            {cmd:"click"}      → {"cmd":"click"}
 *  - Missing "y": in coords   {"x":916, 506}     → {"x":916,"y":506}
 *  - Trailing commas          [1,2,]             → [1,2]
 */
function repairJSON(text) {
  let s = text.trim();
  // 1. Unquoted object keys
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  // 2. Missing "y": after a numeric "x" value  {"x":N, M}  → {"x":N,"y":M}
  s = s.replace(/("x"\s*:\s*-?\d+)\s*,\s*(-?\d+)\s*([,}\]])/g, '$1,"y":$2$3');
  // 3. Trailing commas
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
}

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

  // 4. Try repair + re-parse
  const repaired = repairJSON(trimmed);
  if (repaired !== trimmed) {
    try { return JSON.parse(repaired); } catch (_) {}
    const fenceMatch2 = repaired.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch2) { try { return JSON.parse(fenceMatch2[1].trim()); } catch (_) {} }
    const inlineMatch2 = repaired.match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/);
    if (inlineMatch2) { try { return JSON.parse(inlineMatch2[1]); } catch (_) {} }
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
    // Use a long idle timeout so the rfb _messageLoop survives the AI round-trip.
    // The default 10 s would kill the background read loop while waiting for the
    // AI response, making every subsequent captureScreen time out.
    const opts = { timeout: 120_000, ...this._vncOptions };
    this._vnc = new VNCClient(opts);
    await this._vnc.connect();
  }

  /**
   * Take a screenshot, reconnecting once if the VNC message loop has died.
   */
  async _screenshot() {
    try {
      return await this._vnc.screenshot();
    } catch (err) {
      // Message loop may have timed out — reconnect and retry once.
      try { await this._vnc.disconnect(); } catch (_) {}
      await this.connect();
      return await this._vnc.screenshot();
    }
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
      const screenshot = await this._screenshot();

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
