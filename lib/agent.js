'use strict';

const fs   = require('fs');
const path = require('path');

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
 *
 * Verbosity options:
 *   verbose  (1) – print AI response text + per-action intent
 *   debug    (2) – also print full prompt messages sent to the AI
 *
 * Screenshot saving:
 *   screenshotDir – if set, each screenshot PNG is written to that directory
 *                   as step-N-pre.png (before actions) and step-N-post.png.
 *                   Pass true to auto-create a directory under /tmp/.
 */
class Agent {
  /**
   * @param {object}          options
   * @param {object}          options.vnc                 VNC connection options
   * @param {string}          [options.vnc.host]
   * @param {number}          [options.vnc.port]
   * @param {string}          [options.vnc.password]
   * @param {number}          [options.vnc.timeout]
   * @param {AIClient|object} options.ai
   * @param {string}          [options.systemPrompt]
   * @param {number}          [options.maxSteps]          default 10
   * @param {number}          [options.verbose]           0=silent 1=verbose 2=debug
   * @param {string|boolean}  [options.screenshotDir]     dir path or true for /tmp auto
   */
  constructor(options = {}) {
    this._vncOptions   = options.vnc   || {};
    this._ai           = options.ai instanceof AIClient ? options.ai : new AIClient(options.ai || {});
    this._systemPrompt = options.systemPrompt || SYSTEM_PROMPT;
    this._maxSteps     = options.maxSteps || 10;
    this._verbose      = options.verbose  || 0;
    this._vnc          = null;

    // Resolve screenshot directory
    if (options.screenshotDir === true) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      this._screenshotDir = path.join('/tmp', `rda-${ts}`);
    } else if (options.screenshotDir) {
      this._screenshotDir = options.screenshotDir;
    } else {
      this._screenshotDir = null;
    }

    if (this._screenshotDir) {
      fs.mkdirSync(this._screenshotDir, { recursive: true });
      this._log(1, `Screenshots → ${this._screenshotDir}`);
    }
  }

  _log(level, ...args) {
    if (this._verbose >= level) console.log(...args);
  }

  /** Connect to the VNC server. */
  async connect() {
    // Use a long idle timeout so the rfb _messageLoop survives the AI round-trip.
    const opts = { timeout: 120_000, ...this._vncOptions };
    this._vnc = new VNCClient(opts);
    await this._vnc.connect();
  }

  /** Take a screenshot, reconnecting once if the VNC message loop has died. */
  async _screenshot() {
    try {
      return await this._vnc.screenshot();
    } catch (_err) {
      try { await this._vnc.disconnect(); } catch (_) {}
      await this.connect();
      return await this._vnc.screenshot();
    }
  }

  /** Save a PNG buffer to the screenshot dir (no-op if dir not set). */
  _saveScreenshot(png, filename) {
    if (!this._screenshotDir) return;
    const p = path.join(this._screenshotDir, filename);
    fs.writeFileSync(p, png);
    this._log(1, `  💾 saved ${p}`);
  }

  /** Compare two PNG buffers; return true if they differ beyond a tiny threshold. */
  _screenshotChanged(prev, next) {
    if (!prev || prev.length !== next.length) return true;
    // Quick byte-level diff on a sample of every 512th byte
    let diff = 0;
    for (let i = 0; i < prev.length; i += 512) {
      if (prev[i] !== next[i]) diff++;
    }
    // >1% sampled bytes changed → meaningful change
    return diff > Math.max(1, (prev.length / 512) * 0.01);
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
   * @param {string}   task
   * @param {object}   [opts]
   * @param {Function} [opts.onStep]  (step, actions, responseText) => void
   * @returns {Promise<{steps: number, result: string}>}
   */
  async run(task, opts = {}) {
    if (!this._vnc) await this.connect();

    /** @type {Array<{step:number, actions:Array, note:string}>} */
    const history = [];
    let prevScreenshot = null;

    for (let step = 1; step <= this._maxSteps; step++) {
      // ── 1. Screenshot ───────────────────────────────────────────────────
      const screenshot = await this._screenshot();
      this._saveScreenshot(screenshot, `step-${step}-pre.png`);

      const changed = this._screenshotChanged(prevScreenshot, screenshot);
      if (step > 1 && !changed) {
        this._log(1, `  ⚠  Screen unchanged since last step`);
        // Mark last history entry so the AI knows
        if (history.length > 0) {
          history[history.length - 1].note = 'Screen unchanged after these actions — try a different approach';
        }
      }
      prevScreenshot = screenshot;

      // ── 2. Build prompt ─────────────────────────────────────────────────
      const userMsg  = buildTaskMessage(task, step, history);
      const messages = [
        { role: 'system', content: this._systemPrompt },
        this._ai.buildImageMessage(screenshot, userMsg),
      ];

      if (this._verbose >= 2) {
        console.log('\n─── PROMPT (system) ──────────────────────');
        console.log(this._systemPrompt);
        console.log('─── PROMPT (user) ────────────────────────');
        console.log(userMsg);
        console.log('──────────────────────────────────────────\n');
      }

      // ── 3. Ask AI ───────────────────────────────────────────────────────
      const responseText = await this._ai.chat(messages);

      if (this._verbose >= 1) {
        console.log(`\n─── AI RESPONSE (step ${step}) ──────────────`);
        console.log(responseText);
        console.log('──────────────────────────────────────────\n');
      }

      const parsed = parseResponse(responseText);

      // ── 4. Done? ────────────────────────────────────────────────────────
      if (!Array.isArray(parsed) && parsed.done === true) {
        return { steps: step, result: parsed.result || 'Done' };
      }

      const actions = Array.isArray(parsed) ? parsed : [parsed];

      // ── 5. Log intents ──────────────────────────────────────────────────
      if (opts.onStep) await opts.onStep(step, actions, responseText);

      if (this._verbose >= 1) {
        for (const a of actions) {
          const coords = (a.x !== undefined && a.y !== undefined) ? ` (${a.x}, ${a.y})` : '';
          const extra  = a.text ? ` "${a.text}"` : (a.combo ? ` "${a.combo}"` : '');
          const reason = a.reason ? ` — ${a.reason}` : '';
          console.log(`  ↳ ${a.cmd}${coords}${extra}${reason}`);
        }
      }

      // ── 6. Execute ──────────────────────────────────────────────────────
      await this._vnc.run(actions);

      // ── 7. Post-action screenshot (verbose / saved) ─────────────────────
      if (this._screenshotDir || this._verbose >= 2) {
        const post = await this._screenshot();
        this._saveScreenshot(post, `step-${step}-post.png`);
        prevScreenshot = post;
      }

      // ── 8. Record history ───────────────────────────────────────────────
      history.push({ step, actions, note: '' });
    }

    return { steps: this._maxSteps, result: 'Max steps reached' };
  }
}

module.exports = { Agent, parseResponse };
