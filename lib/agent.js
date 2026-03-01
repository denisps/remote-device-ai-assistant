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
   * @param {number}          [options.maxImageWidth]     downscale screenshots to this width before
   *                                                      sending to AI (default 768; 0 = no resize)
   * @param {number}          [options.gridStep]          overlay a coord grid every N px on the AI
   *                                                      image (default 0 = off; suggested: 100)
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

      // Resize for the AI to reduce base64 payload and speed up inference.
      const realW  = this._vnc.width;
      const realH  = this._vnc.height;
      let imgForAI = this._maxImageWidth > 0
        ? resizePNG(screenshot, this._maxImageWidth)
        : screenshot;
      // Overlay coordinate grid so the model can read positions accurately.
      if (this._gridStep > 0) {
        imgForAI = overlayGridPNG(imgForAI, this._gridStep);
      }
      const { width: imgW, height: imgH } = _decodePNG(imgForAI);
      // Save the image that will actually be sent to the AI (resized + grid overlay)
      this._saveScreenshot(imgForAI, `step-${step}-ai.png`);
      // Qwen3-VL (and Qwen2-VL) always output coordinates in a 0-1000 normalised
      // space regardless of actual image dimensions — that is how the model was
      // trained.  Scale: real = ai_coord / 1000 * screen_dimension.
      const scaleX = realW / 1000;
      const scaleY = realH / 1000;
      this._log(1, `  📷 screenshot ${imgW}×${imgH}` +
        ` (real ${realW}×${realH}, coords 0-1000 → real)` +
        (this._gridStep ? ` [grid ${this._gridStep}-unit]` : '') +
        ` → AI (${(imgForAI.length / 1024).toFixed(0)} KB)`);

      // ── 2. Build prompt ─────────────────────────────────────────────────
      // Remind the model to use the 0-1000 normalised coordinate system.
      const coordNote = '\nCoordinates are 0-1000 normalised: (0,0)=top-left, (1000,1000)=bottom-right.';
      const userMsg  = buildTaskMessage(task, step, history) + coordNote;
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

      // ── 5. Scale coordinates from 0-1000 normalised → real screen pixels ─
      // Qwen3-VL always outputs 0-1000 coords; keep raw values in history so
      // future prompts show the same space the model reasons in.
      const actionsForHistory = actions.map(a => ({ ...a }));
      for (const a of actions) {
        if (a.x !== undefined) a.x = Math.round(a.x * scaleX);
        if (a.y !== undefined) a.y = Math.round(a.y * scaleY);
      }

      // ── 6. Log intents (show real screen coords) ────────────────────────
      if (opts.onStep) await opts.onStep(step, actions, responseText);

      if (this._verbose >= 1) {
        for (let i = 0; i < actions.length; i++) {
          const a   = actions[i];
          const ah  = actionsForHistory[i];
          let coords = '';
          if (a.x !== undefined && a.y !== undefined) {
            coords = ` 0-1000(${ah.x},${ah.y}) → real(${a.x},${a.y})`;
          }
          const extra  = a.text ? ` "${a.text}"` : (a.combo ? ` "${a.combo}"` : '');
          const reason = a.reason ? ` — ${a.reason}` : '';
          console.log(`  ↳ ${a.cmd}${coords}${extra}${reason}`);
        }
      }

      // ── 7. Execute ──────────────────────────────────────────────────────
      await this._vnc.run(actions);

      // ── 8. Post-action screenshot (verbose / saved) ─────────────────────
      if (this._screenshotDir || this._verbose >= 2) {
        const post = await this._screenshot();
        this._saveScreenshot(post, `step-${step}-post.png`);
        prevScreenshot = post;
      }

      // ── 9. Record history (image-space coords for next prompt) ──────────
      history.push({ step, actions: actionsForHistory, note: '' });
    }

    return { steps: this._maxSteps, result: 'Max steps reached' };
  }
}

module.exports = { Agent, parseResponse, overlayGridPNG, resizePNG };
