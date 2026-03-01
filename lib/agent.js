'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const { VNCClient }   = require('vnc-tool/lib/client');
const { encodePNG }   = require('vnc-tool/lib/png');
const { AIClient }    = require('./ai');
const { SYSTEM_PROMPT, buildTaskMessage } = require('./prompts');

// ── PNG resize helpers (pure Node, no extra deps) ─────────────────────────────

/**
 * Decode a filter-0 RGBA PNG (as produced by vnc-tool) into raw RGBA pixels.
 */
function _decodePNG(buf) {
  let pos = 8; // skip PNG signature
  let width = 0, height = 0;
  const idats = [];
  while (pos < buf.length) {
    const len  = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    else if (type === 'IDAT') { idats.push(data); }
    else if (type === 'IEND') { break; }
  }
  const raw  = zlib.inflateSync(Buffer.concat(idats));
  const rgba = Buffer.alloc(width * height * 4);
  const row  = 1 + width * 4;
  for (let y = 0; y < height; y++) {
    raw.copy(rgba, y * width * 4, y * row + 1, (y + 1) * row);
  }
  return { width, height, rgba };
}

/**
 * Nearest-neighbour scale RGBA buffer from (srcW × srcH) to (dstW × dstH).
 */
function _scaleRGBA(rgba, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  const xR  = srcW / dstW;
  const yR  = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.floor(y * yR);
    for (let x = 0; x < dstW; x++) {
      const sx  = Math.floor(x * xR);
      const src = (sy * srcW + sx) * 4;
      const dst = (y  * dstW + x)  * 4;
      out[dst] = rgba[src]; out[dst+1] = rgba[src+1];
      out[dst+2] = rgba[src+2]; out[dst+3] = rgba[src+3];
    }
  }
  return out;
}

/**
 * Resize a PNG to at most `maxWidth` pixels wide (keeps aspect ratio).
 * Returns the original buffer unchanged if already within limit.
 */
function resizePNG(pngBuf, maxWidth) {
  const { width, height, rgba } = _decodePNG(pngBuf);
  if (width <= maxWidth) return pngBuf;
  const dstW   = maxWidth;
  const dstH   = Math.round(height * maxWidth / width);
  const scaled = _scaleRGBA(rgba, width, height, dstW, dstH);
  return encodePNG(dstW, dstH, scaled);
}

// ── Coordinate grid overlay ───────────────────────────────────────────────────

// Minimal 4×6 pixel bitmap font for digits 0-9 (each glyph is 4 cols × 6 rows,
// stored as 6 bitmasks, MSB = leftmost column).
const DIGIT_GLYPHS = [
  [0b1110, 0b1010, 0b1010, 0b1010, 0b1010, 0b1110], // 0
  [0b0100, 0b1100, 0b0100, 0b0100, 0b0100, 0b1110], // 1
  [0b1110, 0b0010, 0b0110, 0b1100, 0b1000, 0b1110], // 2
  [0b1110, 0b0010, 0b0110, 0b0010, 0b0010, 0b1110], // 3
  [0b1010, 0b1010, 0b1110, 0b0010, 0b0010, 0b0010], // 4
  [0b1110, 0b1000, 0b1110, 0b0010, 0b0010, 0b1110], // 5
  [0b1110, 0b1000, 0b1110, 0b1010, 0b1010, 0b1110], // 6
  [0b1110, 0b0010, 0b0100, 0b0100, 0b0100, 0b0100], // 7
  [0b1110, 0b1010, 0b1110, 0b1010, 0b1010, 0b1110], // 8
  [0b1110, 0b1010, 0b1110, 0b0010, 0b0010, 0b1110], // 9
];
const GLYPH_W = 4, GLYPH_H = 6;

function _drawPixel(rgba, w, h, x, y, r, g, b) {
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  const i = (y * w + x) * 4;
  rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = 255;
}

function _drawLabel(rgba, w, h, x, y, label, r, g, b) {
  // Draw each character of the label string (digits only)
  let cx = x;
  for (const ch of String(label)) {
    const d = parseInt(ch, 10);
    if (isNaN(d)) { cx += GLYPH_W + 1; continue; }
    const glyph = DIGIT_GLYPHS[d];
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (glyph[row] & (0b1000 >> col)) {
          _drawPixel(rgba, w, h, cx + col, y + row, r, g, b);
        }
      }
    }
    cx += GLYPH_W + 1;
  }
}

/**
 * Overlay a coordinate grid on raw RGBA data (mutates in place).
 * `step` is in 0-1000 normalised units (Qwen-VL coordinate space).
 * Lines are drawn at pixel positions proportional to image dimensions.
 * Labels show the 0-1000 coordinate value at each intersection.
 */
function _overlayGrid(rgba, w, h, step = 100) {
  const LR = 0, LG = 230, LB = 0;   // grid line color (green)
  const TR = 255, TG = 255, TB = 0;  // text color (yellow)

  // Build list of grid positions in pixels (from 0-1000 normalised units)
  const xPositions = [];
  const yPositions = [];
  for (let u = 0; u <= 1000; u += step) {
    xPositions.push({ px: Math.round(u / 1000 * (w - 1)), label: u });
    yPositions.push({ px: Math.round(u / 1000 * (h - 1)), label: u });
  }

  for (const { px: x } of xPositions) {
    for (let y = 0; y < h; y++) _drawPixel(rgba, w, h, x, y, LR, LG, LB);
  }
  for (const { px: y } of yPositions) {
    for (let x = 0; x < w; x++) _drawPixel(rgba, w, h, x, y, LR, LG, LB);
  }

  // Labels at each grid intersection
  for (const { px: gx, label: lx } of xPositions) {
    for (const { px: gy, label: ly } of yPositions) {
      const label = `${lx},${ly}`;
      const lw = label.length * (GLYPH_W + 1);
      // Black background box
      for (let bx = gx + 1; bx < gx + 1 + lw && bx < w; bx++) {
        for (let by = gy + 1; by < gy + 1 + GLYPH_H + 2 && by < h; by++) {
          _drawPixel(rgba, w, h, bx, by, 0, 0, 0);
        }
      }
      _drawLabel(rgba, w, h, gx + 2, gy + 2, label, TR, TG, TB);
    }
  }
}

/**
 * Return a new PNG with a coordinate grid overlaid.
 * Pass gridStep=0 to skip.
 */
function overlayGridPNG(pngBuf, gridStep) {
  if (!gridStep) return pngBuf;
  const { width, height, rgba } = _decodePNG(pngBuf);
  _overlayGrid(rgba, width, height, gridStep);
  return encodePNG(width, height, rgba);
}

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

  // Flatten: arrays become their contents, plain objects stay as-is
  const actions = [];
  for (const item of allJSON) {
    if (Array.isArray(item)) {
      actions.push(...item);
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
    // VNC idle-read timeout must outlast the longest possible AI inference.
    // Add 30 s buffer on top of the configured AI timeout.
    const vncTimeout = Math.max(120_000, this._ai.timeout + 30_000);
    const opts = { timeout: vncTimeout, ...this._vncOptions };
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
   * Loop: screenshot → ask AI (with reasoning) → extract actions → execute → repeat.
   *
   * @param {string}   task
   * @param {object}   [opts]
   * @param {Function} [opts.onStep]  (step, actions, responseText) => void
   * @returns {Promise<{steps: number, result: string}>}
   */
  async run(task, opts = {}) {
    if (!this._vnc) await this.connect();

    const history = [];         // {step, reasoning, note}
    let prevScreenshot = null;

    for (let step = 1; step <= this._maxSteps; step++) {

      // ── 1. Take a screenshot ────────────────────────────────────────────
      const screenshot = await this._screenshot();
      this._saveScreenshot(screenshot, `step-${step}-pre.png`);

      // ── 2. Record outcome of previous step ──────────────────────────────
      if (step > 1 && history.length > 0) {
        const changed = this._screenshotChanged(prevScreenshot, screenshot);
        if (!changed) {
          this._log(1, `  ⚠  Screen unchanged since last step`);
          history[history.length - 1].note =
            'OUTCOME: Screen did NOT change — the action had no visible effect. You MUST try something different.';
        } else {
          this._log(1, `  ✓  Screen changed`);
          history[history.length - 1].note =
            'OUTCOME: Screen changed — check whether this matches your expected result.';
        }
      }
      prevScreenshot = screenshot;

      // ── 3. Resize image for AI ──────────────────────────────────────────
      const realW  = this._vnc.width;
      const realH  = this._vnc.height;
      const imgForAI = this._maxImageWidth > 0
        ? resizePNG(screenshot, this._maxImageWidth)
        : screenshot;
      const { width: imgW, height: imgH } = _decodePNG(imgForAI);
      this._saveScreenshot(imgForAI, `step-${step}-ai.png`);

      // ── 4. Compute coordinate scale ─────────────────────────────────────
      const isNorm = this._coordSystem === 'norm1000';
      const scaleX = isNorm ? realW / 1000 : realW / imgW;
      const scaleY = isNorm ? realH / 1000 : realH / imgH;

      this._log(1, `  📷 step ${step}: ${imgW}×${imgH}` +
        ` (real ${realW}×${realH}) → AI (${(imgForAI.length / 1024).toFixed(0)} KB)`);

      // ── 5. Build prompt ─────────────────────────────────────────────────
      const coordNote = isNorm
        ? '\nCoordinates: 0-1000 normalised. (0,0)=top-left, (1000,1000)=bottom-right.'
        : `\nCoordinates: pixel values of the image (${imgW}×${imgH}).`;
      const userMsg = buildTaskMessage(task, step, history) + coordNote;
      const messages = [
        { role: 'system', content: this._systemPrompt },
        this._ai.buildImageMessage(imgForAI, userMsg),
      ];

      if (this._verbose >= 2) {
        console.log('\n─── PROMPT (system) ──────────────────────');
        console.log(this._systemPrompt);
        console.log('─── PROMPT (user) ────────────────────────');
        console.log(userMsg);
        console.log('──────────────────────────────────────────\n');
      }

      // ── 6. Ask AI ───────────────────────────────────────────────────────
      const responseText = await this._ai.chat(messages);

      if (this._verbose >= 1) {
        console.log(`\n─── AI RESPONSE (step ${step}) ──────────────`);
        console.log(responseText);
        console.log('──────────────────────────────────────────\n');
      }

      // ── 7. Parse response (extract actions from reasoning) ──────────────
      const parsed = parseResponse(responseText);

      // Done signal?
      if (!Array.isArray(parsed) && parsed.done === true) {
        return { steps: step, result: parsed.result || 'Done' };
      }

      const actions = Array.isArray(parsed) ? parsed : [parsed];

      // ── 8. Scale coordinates → real screen pixels ───────────────────────
      for (const a of actions) {
        if (a.x !== undefined) a.x = Math.round(a.x * scaleX);
        if (a.y !== undefined) a.y = Math.round(a.y * scaleY);
      }

      // ── 9. Notify caller ────────────────────────────────────────────────
      if (opts.onStep) await opts.onStep(step, actions, responseText);

      if (this._verbose >= 1) {
        for (const a of actions) {
          const coords = (a.x !== undefined && a.y !== undefined)
            ? ` (${a.x},${a.y})` : '';
          const extra  = a.text ? ` "${a.text}"` : (a.combo ? ` "${a.combo}"` : '');
          console.log(`  ↳ ${a.cmd}${coords}${extra}`);
        }
      }

      // ── 10. Execute actions on the device ───────────────────────────────
      await this._vnc.run(actions);

      // ── 11. Save post-action screenshot if needed ───────────────────────
      if (this._screenshotDir || this._verbose >= 2) {
        const post = await this._screenshot();
        this._saveScreenshot(post, `step-${step}-post.png`);
        prevScreenshot = post;
      }

      // ── 12. Record reasoning in history for future steps ────────────────
      // The raw AI text becomes the history: the model reads its own past
      // reasoning to understand what it tried and what happened.
      const reasoning = responseText.trim().slice(0, 1500); // cap length
      history.push({ step, reasoning, note: '' });
    }

    return { steps: this._maxSteps, result: 'Max steps reached' };
  }
}

module.exports = { Agent, parseResponse, overlayGridPNG, resizePNG };
