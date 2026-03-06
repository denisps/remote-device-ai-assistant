'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const { VNCClient }   = require('vnc-tool/lib/client');
const { AIClient }    = require('./ai');
const { SYSTEM_PROMPT, buildTaskMessage, buildSummaryRequest } = require('./prompts');
const { ImageRaw, ImagePNG } = require('./image');

// ── Small async utility ───────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// image utilities are now encapsulated in ImageRaw/ImagePNG classes
// (the old helper functions are no longer required here)


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
    this._mouseX       = 0;    // track cursor position for rendering
    this._mouseY       = 0;

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
    await new Promise((resolve, reject) => {
      const onError = (err) => { reject(err); };
      this._vnc.once('error', onError);
      connectPromise
        .then(() => { this._vnc.removeListener('error', onError); resolve(); })
        .catch((err) => { this._vnc.removeListener('error', onError); reject(err); });
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

    // buffered path
    if (this._screenBuffer) {
      const { width, height, rgba } = this._screenBuffer.captureScreen();
      return ImageRaw.fromRaw(width, height, rgba);
    }

    // fallback: grab PNG and decode into raw
    try {
      const png = await this.screenshot();
      return ImageRaw.fromPNG(png);
    } catch (e) {
      return null;
    }
  }



  // ── Screenshot utilities ────────────────────────────────────────────────────

  /**
   * Save an image (raw or PNG) to the screenshot directory.
   * The `img` argument may be an ImageRaw, ImagePNG, or Buffer.
   */
  saveScreenshot(img, filename) {
    if (!this._screenshotDir) return;
    let pngBuf;
    if (img instanceof ImageRaw) {
      pngBuf = img.encodePNG().buffer;
    } else if (img instanceof ImagePNG) {
      pngBuf = img.buffer;
    } else if (Buffer.isBuffer(img)) {
      pngBuf = img;
    } else {
      throw new Error('Unsupported image type for saveScreenshot');
    }
    const p = path.join(this._screenshotDir, filename);
    fs.writeFileSync(p, pngBuf);
    this._log(1, `  💾 saved ${p}`);
  }

  /**

  /**
   * After executing actions, poll the screen until it visibly changes or the
   * timeout is reached. Returns early as soon as a significant change is detected.
   *
   * The VNC screen-buffer's `updateCount` is a *float* where +1 equals a
   * number of altered pixels equal to the entire framebuffer area.
   * Internally we treat `minChange` as the required delta against the start
   * count; fractional values are accepted so callers can say `0.1` for a
   * 10%‑screen change, `2.5` for two and a half screens worth of movement, etc.
   *
   * @param {Buffer} baselinePng  Screenshot taken just before the actions
   * @param {number} [maxWait=3000]      Max time to wait in ms
   * @param {number} [pollInterval=400]  How often to check in ms
   * @param {number} [minChange=1]       Minimum `updateCount` delta required
   * @returns {Promise<{screenshot: Buffer, changed: boolean}>}
   */
  /**
   * After executing actions, wait until the VNC screen buffer reports a
   * visible update or the timeout expires. The caller is responsible for
   * taking any screenshots; historically this helper used to grab one when
   * changes were observed or on timeout, but that extra I/O is unnecessary
   * now that we always capture the "pre" screenshot at the start of the
   * loop. Removing the image logic also makes the helper much easier to
   * test.
   *
   * @param {object} [options]
   * @param {number} [options.maxWait=3000]     max time to wait in ms
   * @param {number} [options.pollInterval=400] how often to check in ms
   * @param {number} [options.minChange=1]      required updateCount delta
   * @returns {Promise<{changed:boolean}>}
   */
  async waitForScreenChange({ maxWait = 3000, pollInterval = 400, minChange = 1 } = {}) {
    // Use the screen buffer's updateCount for efficient change detection.
    const startCount = this._screenBuffer ? this._screenBuffer.updateCount : 0;
    const deadline = Date.now() + maxWait;

    while (Date.now() < deadline) {
      await _sleep(pollInterval);
      if (this._screenBuffer) {
        const delta = this._screenBuffer.updateCount - startCount;
        if (delta < minChange) {
          // not enough updates yet – keep waiting
          continue;
        }
        // updateCount jumped enough; we consider that a meaningful change
        return { changed: true };
      }
      // if there's no screen buffer we can't detect change, so just keep
      // polling until deadline and then time out
    }

    // timeout expired, caller can decide what to do (e.g. grab a screenshot)
    return { changed: false };
  }

  // ── AI communication ────────────────────────────────────────────────────────

  /**
   * Build the messages array (system + user-with-image) to send to the AI.
   * Accepts an ImageRaw or ImagePNG.
   */
  buildMessages(task, step, history, img) {
    const coordNote = img.isNorm
      ? '\nCoordinates: 0-1000 normalised. (0,0)=top-left, (1000,1000)=bottom-right.'
      : `\nCoordinates: pixel values of the image (${img.width}×${img.height}).`;
    const userText = buildTaskMessage(task, step, history) + coordNote;

    const png = img instanceof ImageRaw ? img.encodePNG() : img;
    const dataUrl = png.encodeForModel();

    const content = [
      { type: 'image_url', image_url: { url: dataUrl } },
    ];
    // no need to include text part here; AIClient.buildImageMessage will wrap if provided

    return [
      { role: 'system', content: this._systemPrompt },
      { role: 'user', content },
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
   * Each action is processed individually with appropriate behavior:
   * - move/click: animated movement with interpolated steps
   * - dmove: delta (relative) movement from current position
   * - type/key/scroll/delay: executed directly
   * 
   * @param {Array} actions
   */
  async execute(actions) {
    for (const action of actions) {
      const cmd = action.cmd;
      
      if (cmd === 'move') {
        // Determine target coordinates; if none provided, use current mouse location
        const targetX = (action.x !== undefined) ? action.x : this._mouseX;
        const targetY = (action.y !== undefined) ? action.y : this._mouseY;
        const steps = 8; // number of interpolation steps
        
        for (let i = 1; i <= steps; i++) {
          const t = i / steps; // 0 to 1
          const x = Math.round(this._mouseX + (targetX - this._mouseX) * t);
          const y = Math.round(this._mouseY + (targetY - this._mouseY) * t);
          await this._vnc.run([{ cmd: 'move', x, y }]);
          await _sleep(10); // small delay for smooth animation
        }
        
        this._mouseX = targetX;
        this._mouseY = targetY;
        
      } else if (cmd === 'click') {
          await this._vnc.run([{ cmd: 'click', button: action.button || 'left' }]);
      } else if (cmd === 'dmove') {
        // Delta move: relative movement from current position
        const dx = action.dx || 0;
        const dy = action.dy || 0;
        const targetX = this._mouseX + dx;
        const targetY = this._mouseY + dy;
        
        // Animate the delta movement
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const x = Math.round(this._mouseX + dx * t);
          const y = Math.round(this._mouseY + dy * t);
          await this._vnc.run([{ cmd: 'move', x, y }]);
          await _sleep(10);
        }
        
        this._mouseX = targetX;
        this._mouseY = targetY;
        
      } else if (cmd === 'type') {
        await this._vnc.run([{ cmd: 'type', text: action.text }]);
        
      } else if (cmd === 'key') {
        await this._vnc.run([{ cmd: 'key', combo: action.combo }]);
        
      } else if (cmd === 'scroll') {
        // new parameters h/v (horizontal/vertical); provide zero defaults
        const h = action.h !== undefined ? action.h : (action.dx || 0);
        const v = action.v !== undefined ? action.v : (action.dy || action.amount || 0);
        await this._vnc.run([{ cmd: 'scroll', h, v, amount: v }]);
        
      } else if (cmd === 'delay') {
        const ms = action.ms || 500;
        await _sleep(ms);
        
      } else {
        // Unknown command - log and skip
        this._log(1, `  ⚠  Unknown command: ${cmd}`);
      }
    }
  }

  // ── Console logging ─────────────────────────────────────────────────────────

  logStep(step, img) {
    const rgbaKB = (img.rgba ? img.rgba.length : img.width * img.height * 4) / 1024;
    this._log(1, `  📷 step ${step}/${this._maxSteps}: ${img.width}×${img.height}` +
      ` (real ${this._vnc.width}×${this._vnc.height}) RGBA: ${rgbaKB.toFixed(0)} KB`);
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
   * Capture a screenshot as an ImageRaw instance.
   * @returns {Promise<ImageRaw>}
   * @throws {Error} if screenshot cannot be captured
   */
  async captureStepScreenshot() {
    const rawShotObj = await this.screenshotRaw();
    if (!rawShotObj) {
      throw new Error('Unable to capture screenshot (VNC connection lost?)');
    }
    return rawShotObj; // already an ImageRaw
  }

  /**
   * Process AI response: parse, check for completion, scale actions.
   * @param {string} responseText  Raw AI response
   * @param {object} img          Image metadata from prepareImage
   * @returns {{done: boolean, actions?: Array, result?: string}}
   */
  processAIResponse(responseText, img) {
    const parsed = parseResponse(responseText);
    
    if (parsed.done) {
      return { done: true, result: parsed.result || 'Done' };
    }
    
    const rawActions = Array.isArray(parsed) ? parsed : [parsed];
    const actions = this.scaleActions(rawActions, img);
    
    return { done: false, actions };
  }

  /**
   * Calculate minimum screen change to wait for based on action hints.
   * @param {Array} actions
   * @returns {number}  Minimum change factor (0-1)
   */
  calculateMinChange(actions) {
    let minChange = 0;
    for (const a of actions) {
      if (a.minChange !== undefined) {
        const hint = parseFloat(a.minChange);
        if (!isNaN(hint) && hint > minChange) {
          minChange += hint;
        }
      }
    }
    return minChange || 0.1; // default to 10% screen change
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

    let history = [];
    let lastUpdateCount = this._screenBuffer?.updateCount ?? 0;
    let finalResult = { steps: maxSteps, result: 'Max steps reached' };

    for (let step = 1; step <= maxSteps; step++) {
      const screenshot = await this.captureStepScreenshot();
      this.saveScreenshot(screenshot, `step-${step}.png`);
      lastUpdateCount = this._screenBuffer?.updateCount ?? lastUpdateCount;

      // Condense history if needed
      history = await this.summarizeHistory(history, task);

      // prepare screenshot for AI
      let img = screenshot;
      if (this._maxImageWidth > 0) {
        img = img.resize(this._maxImageWidth);
      }
      const cursorScaleX = img.width / this._vnc.width;
      const cursorScaleY = img.height / this._vnc.height;
      const cursorX = Math.round(this._mouseX * cursorScaleX);
      const cursorY = Math.round(this._mouseY * cursorScaleY);
      img.drawCursor(cursorX, cursorY);
      if (this._gridStep > 0) img.overlayGrid(this._gridStep);

      this.saveScreenshot(img, `step-${step}-ai.png`);
      this.logStep(step, img);

      // build metadata for scaling and coordinate notes
      const isNorm = this._coordSystem === 'norm1000';
      const scaleX = isNorm ? this._vnc.width / 1000 : this._vnc.width / img.width;
      const scaleY = isNorm ? this._vnc.height / 1000 : this._vnc.height / img.height;
      const imgMeta = { width: img.width, height: img.height, scaleX, scaleY, isNorm };

      // Get AI response
      const messages = this.buildMessages(task, step, history, img);
      this.logPrompt(messages);
      const responseText = await this.chat(messages);
      this.logResponse(step, responseText);

      // Process response
      const result = this.processAIResponse(responseText, imgMeta);
      if (result.done) {
        finalResult = { steps: step, result: result.result };
        break;
      }

      const actions = result.actions;

      // Notify callback and log
      if (onStep) onStep(step, actions);
      if (this._verbose >= 1) printStepSummary(step, actions);
      this.logActions(actions);

      // Execute actions
      await this.execute(actions);

      // Wait for screen to update
      const minChange = this.calculateMinChange(actions);
      await this.waitForScreenChange({ minChange });

      // Update tracking for next iteration
      lastUpdateCount = this._screenBuffer?.updateCount ?? lastUpdateCount;
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

module.exports = { Agent, parseResponse, printStepSummary };
