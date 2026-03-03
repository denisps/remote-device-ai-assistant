'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const { VNCClient }   = require('vnc-tool/lib/client');
const { encodePNG }   = require('vnc-tool/lib/png');
const { AIClient }    = require('./ai');
const { SYSTEM_PROMPT, buildTaskMessage, buildSummaryRequest } = require('./prompts');

// ── Small async utility ───────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Image helpers moved to image.js ──────────────────────────────────────────
const { resizePNG, overlayGridPNG, decodePNG } = require('./image');

// ─────────────────────────────────────────────────────────────────────────────

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
 * Try to parse a single JSON string, with fallback to repairJSON.
 */
function _tryParse(str) {
  try { return JSON.parse(str); } catch (_) {}
  const repaired = repairJSON(str);
  try { return JSON.parse(repaired); } catch (_) {}
  return null;
}

/**
 * Extract all JSON objects/arrays embedded in free-form reasoning text.
 *
 * Uses a brace/bracket depth tracker to find valid JSON boundaries even when
 * the model embeds multiple JSON snippets in prose. Returns them in order.
 */
function _extractAllJSON(text) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      let depth = 1;
      let j = i + 1;
      let inStr = false;
      let esc = false;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (esc)           { esc = false; }
        else if (c === '\\') { esc = true; }
        else if (c === '"')  { inStr = !inStr; }
        else if (!inStr) {
          if (c === ch)    depth++;
          if (c === close) depth--;
        }
        j++;
      }
      if (depth === 0) {
        const candidate = text.slice(i, j);
        const parsed = _tryParse(candidate);
        if (parsed !== null) {
          results.push(parsed);
          i = j;
          continue;
        }
      }
    }
    i++;
  }
  return results;
}

/**
 * Parse the AI response text and return actions + the raw reasoning text.
 *
 * The model now responds with free-form reasoning that has JSON actions
 * embedded inline. This function:
 * 1. Checks if it's a pure done-object
 * 2. Extracts all JSON from fenced blocks or inline text
 * 3. Separates done-signals from action commands
 * 4. Returns { actions, reasoning, done, result }
 *
 * @param {string} text  Raw AI response
 * @returns {{actions: Array, reasoning: string, done: boolean, result?: string}}
 * @throws {Error} if no valid JSON can be found
 */
function parseResponse(text) {
  if (!text) throw new Error('Empty AI response');
  const trimmed = text.trim();

  // ── Fast path: pure JSON (no reasoning text) ────────────────────────────
  const direct = _tryParse(trimmed);
  if (direct !== null) {
    if (!Array.isArray(direct) && direct.done === true) {
      return direct;  // { done: true, result: "..." }
    }
    const arr = Array.isArray(direct) ? direct : [direct];
    return arr;
  }

  // ── Fenced code blocks ─────────────────────────────────────────────────
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let fencedJSON = [];
  let m;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    const parsed = _tryParse(m[1].trim());
    if (parsed !== null) fencedJSON.push(parsed);
  }

  // ── Inline JSON extraction ─────────────────────────────────────────────
  const allJSON = fencedJSON.length > 0 ? fencedJSON : _extractAllJSON(trimmed);

  if (allJSON.length === 0) {
    throw new Error(`Could not parse AI response as JSON: ${text.slice(0, 200)}`);
  }

  // Check for done-signal among extracted objects
  for (const obj of allJSON) {
    if (obj && !Array.isArray(obj) && obj.done === true) {
      return obj;
    }
  }

  // Flatten: arrays become their contents, plain objects stay as-is.
  // Guard against numeric/primitive arrays (e.g. bounding-box coords in reasoning).
  const actions = [];
  for (const item of allJSON) {
    if (Array.isArray(item)) {
      for (const el of item) {
        if (el && typeof el === 'object' && el.cmd) actions.push(el);
      }
    } else if (item && item.cmd) {
      actions.push(item);
    }
  }

  if (actions.length === 0) {
    throw new Error(`Could not parse AI response as JSON: ${text.slice(0, 200)}`);
  }

  return actions;
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
   * @param {number}          [options.maxImageWidth]     downscale screenshots to this width before
   *                                                      sending to AI (default 768; 0 = no resize)
   * @param {number}          [options.gridStep]          overlay a coord grid every N px on the AI
   *                                                      image (default 0 = off; suggested: 100)
   * @param {'norm1000'|'pixels'} [options.coordSystem]  how to interpret AI-returned coords:
   *                                                      'norm1000' = 0-1000 normalised (Qwen-VL default)
   *                                                      'pixels'   = pixel coords of the image sent
   *                                                      auto-detected during setup and saved in config
   * @param {number}          [options.aiTimeout]         override AI request timeout ms
   */
  constructor(options = {}) {
    this._vncOptions   = options.vnc   || {};
    const aiOpts       = { ...(options.ai || {}) };
    if (options.aiTimeout) aiOpts.timeout = options.aiTimeout;
    this._ai           = options.ai instanceof AIClient ? options.ai : new AIClient(aiOpts);
    this._systemPrompt = options.systemPrompt || SYSTEM_PROMPT;
    this._maxSteps     = options.maxSteps || 10;
    this._verbose      = options.verbose  || 0;
    this._maxImageWidth = options.maxImageWidth !== undefined ? options.maxImageWidth : 768;
    this._gridStep     = options.gridStep || 0;
    this._coordSystem  = options.coordSystem || 'norm1000';
    this._vnc          = null;
    this._screenBuffer = null;

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

  // ── VNC connection ──────────────────────────────────────────────────────────

  /** Connect to the VNC server. VNC idle timeout is set to outlast AI inference. */
  async connect() {
    const vncTimeout = Math.max(120_000, this._ai.timeout + 30_000);
    this._vnc = new VNCClient({ timeout: vncTimeout, ...this._vncOptions });
    // VNCClient.connect() assigns this._vnc._rfb synchronously before its first
    // await, so we can grab the underlying RFBClient (an EventEmitter) right
    // after starting the call. We race the connect promise against the 'error'
    // event so socket errors (ECONNREFUSED, ETIMEDOUT, …) become real promise
    // rejections rather than crashing the process.
    const connectPromise = this._vnc.connect();
    const rfb = this._vnc._rfb;
    await new Promise((resolve, reject) => {
      rfb.once('error', reject);
      connectPromise
        .then(() => { rfb.removeListener('error', reject); resolve(); })
        .catch((err) => { rfb.removeListener('error', reject); reject(err); });
    });
    // Initialize screen buffering for efficient synchronous screen captures
    this._screenBuffer = await this._vnc.startScreenBuffering();
  }

  /** Disconnect from the VNC server. */
  async disconnect() {
    if (this._vnc) {
      await this._vnc.disconnect();
      this._vnc = null;
      this._screenBuffer = null;
    }
  }

  /**
   * Take a PNG screenshot, auto-reconnecting once if the VNC message loop has died.
   * This is the old behaviour used by most callers. If you only need the raw
   * RGBA framebuffer (for example, to perform internal comparisons) use
   * {@link screenshotRaw} instead – it avoids the cost of PNG
   * encoding/decoding until you actually need an image file.
   *
   * @returns {Promise<Buffer>} PNG buffer
   */
  async screenshot() {
    try {
      return await this._vnc.screenshot();
    } catch (_) {
      // reconnect once and retry
      try { await this._vnc.disconnect(); } catch (__) {}
      await this.connect();
      return await this._vnc.screenshot();
    }
  }

  /**
   * Return the raw RGBA framebuffer as a Buffer. The buffer has length
   * width*height*4; if the client has not received any updates yet it'll be
   * null. This is a cheap getter (no PNG work) and is useful when you just
   * want to detect whether the screen changed or perform your own encoding
   * later.
   *
   * The returned object also includes the current dimensions so callers don't
   * have to separately query the client.
   *
   * @returns {{width:number,height:number,rgba:Buffer}|null}
   */
  async screenshotRaw() {
    if (!this._vnc) return null;
    
    // Use the new efficient screen buffer API (synchronous, no I/O)
    if (this._screenBuffer) {
      const { width, height, rgba } = this._screenBuffer.captureScreen();
      return { width, height, rgba };
    }

    // Fallback: for compatibility with older vnc-tool or if buffer not initialized
    try {
      const png = await this.screenshot();
      const { width, height, rgba } = decodePNG(png);
      return { width, height, rgba };
    } catch (e) {
      return null;
    }
  }

  // ── Image preparation ───────────────────────────────────────────────────────

  /**
   * Resize screenshot for AI and compute the coordinate scales.
   * @param {Buffer} png  Raw screenshot
   * @returns {{ buffer, realW, realH, imgW, imgH, scaleX, scaleY, isNorm }}
   */
  prepareImage(pngOrRaw) {
    const realW  = this._vnc.width;
    const realH  = this._vnc.height;

    let buffer;
    let imgW, imgH;

    if (pngOrRaw && pngOrRaw.length === realW * realH * 4) {
      // raw RGBA buffer
      let rgba = pngOrRaw;
      imgW = realW;
      imgH = realH;
      if (this._maxImageWidth > 0 && imgW > this._maxImageWidth) {
        const dstW = this._maxImageWidth;
        const dstH = Math.round(realH * dstW / realW);
        const { scaleRGBA } = require('./image');
        rgba = scaleRGBA(rgba, realW, realH, dstW, dstH);
        imgW = dstW;
        imgH = dstH;
      }
      buffer = encodePNG(imgW, imgH, rgba);
    } else {
      // png buffer path (original behaviour)
      const png = pngOrRaw;
      buffer = this._maxImageWidth > 0 ? resizePNG(png, this._maxImageWidth) : png;
      const dims = decodePNG(buffer);
      imgW = dims.width; imgH = dims.height;
    }

    const isNorm = this._coordSystem === 'norm1000';
    const scaleX = isNorm ? realW / 1000 : realW / imgW;
    const scaleY = isNorm ? realH / 1000 : realH / imgH;
    return { buffer, realW, realH, imgW, imgH, scaleX, scaleY, isNorm };
  }

  // ── Screenshot utilities ────────────────────────────────────────────────────

  /**
   * Save a screenshot to disk. `data` may be either a PNG buffer or a raw
   * RGBA buffer; the latter will be converted using the bundled `encodePNG`
   * helper. The filename should include the `.png` extension as usual.
   *
   * This is a no-op if no screenshot directory was configured.
   */
  saveScreenshot(data, filename) {
    if (!this._screenshotDir) return;
    let png = data;
    // heuristic: if the buffer length equals width*height*4 then treat it as raw
    if (this._vnc && data && data.length === this._vnc.width * this._vnc.height * 4) {
      png = encodePNG(this._vnc.width, this._vnc.height, data);
    }
    const p = path.join(this._screenshotDir, filename);
    fs.writeFileSync(p, png);
    this._log(1, `  💾 saved ${p}`);
  }

  /**
   * Compare two PNGs; return true if they differ beyond a small noise threshold.
   * Samples every 512th byte for speed.
   */
  screenshotChanged(prev, next) {
    if (!prev || prev.length !== next.length) return true;
    let diff = 0;
    for (let i = 0; i < prev.length; i += 512) {
      if (prev[i] !== next[i]) diff++;
    }
    return diff > Math.max(1, (prev.length / 512) * 0.01);
  }

  /**
   * After executing actions, poll the screen until it visibly changes or the
   * timeout is reached. Returns early as soon as a significant change is detected.
   *
   * @param {Buffer} baselinePng  Screenshot taken just before the actions
   * @param {number} [maxWait=3000]      Max time to wait in ms
   * @param {number} [pollInterval=400]  How often to check in ms
   * @returns {Promise<{screenshot: Buffer, changed: boolean}>}
   */
  async waitForScreenChange(baselinePng, { maxWait = 3000, pollInterval = 400 } = {}) {
    // Use the screen buffer's updateCount for efficient change detection
    const startCount = this._screenBuffer ? this._screenBuffer.updateCount : 0;
    const deadline = Date.now() + maxWait;

    while (Date.now() < deadline) {
      await _sleep(pollInterval);
      if (this._screenBuffer && this._screenBuffer.updateCount === startCount) {
        // no visible updates yet — skip the expensive screenshot call
        continue;
      }
      // framebuffer updated; grab a fresh copy and return immediately.  The
      // updateCount delta is considered sufficient evidence that something
      // meaningful has changed; we no longer bother comparing against the
      // baseline image which could be costly and may even misfire on tiny
      // differences.
      const current = await this.screenshot();
      return { screenshot: current, changed: true };
    }

    // timeout expired; take one final screenshot so caller has something to
    // work with
    const final = await this.screenshot();
    return { screenshot: final, changed: false };
  }

  // ── AI communication ────────────────────────────────────────────────────────

  /**
   * Build the messages array (system + user-with-image) to send to the AI.
   * @param {string} task
   * @param {number} step
   * @param {Array}  history
   * @param {{ buffer, imgW, imgH, isNorm }} img  Result of prepareImage()
   * @returns {Array}  Messages array for ai.chat()
   */
  buildMessages(task, step, history, img) {
    const coordNote = img.isNorm
      ? '\nCoordinates: 0-1000 normalised. (0,0)=top-left, (1000,1000)=bottom-right.'
      : `\nCoordinates: pixel values of the image (${img.imgW}×${img.imgH}).`;
    const userText = buildTaskMessage(task, step, history) + coordNote;
    return [
      { role: 'system', content: this._systemPrompt },
      this._ai.buildImageMessage(img.buffer, userText),
    ];
  }

  /**
   * Send messages to the AI and return the response text.
   * @param {Array} messages
   * @returns {Promise<string>}
   */
  async chat(messages) {
    return this._ai.chat(messages);
  }

  // ── History management ──────────────────────────────────────────────────────

  /**
   * Annotate the last history entry with the outcome of the step
   * (did the screen visibly change?).
   * @param {Array}   history
   * @param {boolean} changed
   */
  annotateOutcome(history, changed) {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    if (!changed) {
      this._log(1, '  ⚠  Screen unchanged — action had no visible effect');
      last.note = 'OUTCOME: Screen did NOT change — the action had no visible effect. You MUST try a different approach.';
    } else {
      this._log(1, '  ✓  Screen changed');
      last.note = 'OUTCOME: Screen changed — evaluate whether it matches your expected result.';
    }
  }

  /**
   * If history is long, ask the AI to summarise it into a single compact entry.
   * This prevents the prompt from growing unboundedly across many steps.
   *
   * @param {Array}  history
   * @param {string} task
   * @param {number} [limit=6]  Trigger summarisation after this many entries
   * @returns {Promise<Array>}  Original or summarised history
   */
  async summarizeHistory(history, task, limit = 6) {
    if (history.length <= limit) return history;

    this._log(1, `  📝 History has ${history.length} entries — asking AI to summarise`);
    try {
      const messages = buildSummaryRequest(task, history);
      const summary  = await this._ai.chat(messages);
      const lastStep = history[history.length - 1].step;
      return [{ step: `1-${lastStep} (summary)`, reasoning: summary.trim(), note: '' }];
    } catch (err) {
      this._log(1, `  ⚠  History summarisation failed (${err.message}) — keeping recent entries`);
      return history.slice(-limit);
    }
  }

  // ── Action execution ────────────────────────────────────────────────────────

  /**
   * Scale actions from AI coordinate space to real screen pixels.
   * @param {Array}  actions  Actions with coords in AI space
   * @param {{ scaleX, scaleY }} img
   * @returns {Array}  New actions with real pixel coords
   */
  scaleActions(actions, img) {
    return actions.map(a => {
      const scaled = { ...a };
      if (scaled.x !== undefined) scaled.x = Math.round(scaled.x * img.scaleX);
      if (scaled.y !== undefined) scaled.y = Math.round(scaled.y * img.scaleY);
      return scaled;
    });
  }

  /**
   * Execute actions on the remote device via VNC.
   * @param {Array} actions
   */
  async execute(actions) {
    await this._vnc.run(actions);
  }

  // ── Console logging ─────────────────────────────────────────────────────────

  logStep(step, img) {
    this._log(1, `  📷 step ${step}/${this._maxSteps}: ${img.imgW}×${img.imgH}` +
      ` (real ${img.realW}×${img.realH}) → AI (${(img.buffer.length / 1024).toFixed(0)} KB)`);
  }

  logPrompt(messages) {
    if (this._verbose < 2) return;
    console.log('\n─── PROMPT (system) ──────────────────────');
    console.log(messages[0].content);
    console.log('─── PROMPT (user) ────────────────────────');
    const userContent = messages[1].content;
    const textPart = Array.isArray(userContent)
      ? userContent.find(p => p.type === 'text')?.text
      : userContent;
    if (textPart) console.log(textPart);
    console.log('──────────────────────────────────────────\n');
  }

  logResponse(step, text) {
    if (this._verbose < 1) return;
    console.log(`\n─── AI RESPONSE (step ${step}) ──────────────`);
    console.log(text);
    console.log('──────────────────────────────────────────\n');
  }

  logActions(actions) {
    if (this._verbose < 1) return;
    for (const a of actions) {
      const coords = a.x !== undefined ? ` (${a.x},${a.y})` : '';
      const extra  = a.text ? ` "${a.text}"` : (a.combo ? ` "${a.combo}"` : '');
      console.log(`  ↳ ${a.cmd}${coords}${extra}`);
    }
  }

  /**
   * Run a natural‑language task using the current agent configuration. This
   * is the programmatic equivalent of the CLI's `runTask` helper.
   *
   * @param {string} task
   * @param {object} [opts]
   * @param {number} [opts.maxSteps]           override this._maxSteps
   * @param {function} [opts.onStep]           callback(step, actions)
   * @returns {Promise<{steps:number,result:string}>}
   */
  async run(task, opts = {}) {
    const maxSteps = opts.maxSteps || this._maxSteps;
    const onStep   = opts.onStep || null;

    let history             = [];
    let preActionScreenshot = null;
    let finalResult         = { steps: maxSteps, result: 'Max steps reached' };

    for (let step = 1; step <= maxSteps; step++) {
      const rawShotObj = await this.screenshotRaw();
      const screenshot = rawShotObj ? rawShotObj.rgba : Buffer.alloc(0);
      this.saveScreenshot(screenshot, `step-${step}-pre.png`);

      if (preActionScreenshot !== null) {
        const changed = this.screenshotChanged(preActionScreenshot, screenshot);
        this.annotateOutcome(history, changed);
      }

      history = await this.summarizeHistory(history, task);

      const img = this.prepareImage(screenshot);
      this.saveScreenshot(img.buffer, `step-${step}-ai.png`);
      this.logStep(step, img);

      const messages = this.buildMessages(task, step, history, img);
      this.logPrompt(messages);
      const responseText = await this.chat(messages);
      this.logResponse(step, responseText);

      const parsed = parseResponse(responseText);
      if (parsed.done) {
        finalResult = { steps: step, result: parsed.result || 'Done' };
        break;
      }

      const rawActions = Array.isArray(parsed) ? parsed : [parsed];
      const actions    = this.scaleActions(rawActions, img);

      if (onStep) onStep(step, actions);
      printStepSummary(step, actions);
      this.logActions(actions);

      preActionScreenshot = screenshot;
      await this.execute(actions);

      const { screenshot: postPng } = await this.waitForScreenChange(screenshot);
      this.saveScreenshot(postPng, `step-${step}-post.png`);

      history.push({ step, reasoning: responseText.trim(), note: '' });
    }

    return finalResult;
  }
}

/**
 * Print a one-line summary of what the agent is about to do this step.
 * Similar to the CLI helper but also exported so tests and Agent.run can use it.
 */
function printStepSummary(step, actions) {
  const parts = actions.map(a => {
    const coords = a.x !== undefined ? ` (${a.x},${a.y})` : '';
    const extra  = a.text ? ` "${a.text}"` : (a.combo ? ` "${a.combo}"` : '');
    return `${a.cmd}${coords}${extra}`;
  });
  const summary = parts.join('; ');
  console.log(`→ Step ${step}: ${summary.slice(0, 120)}${summary.length > 120 ? '…' : ''}`);
}

module.exports = { Agent, parseResponse, overlayGridPNG, resizePNG, printStepSummary };
