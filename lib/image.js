// image.js — image manipulation helpers for agent.js
'use strict';

const zlib = require('zlib');
const { encodePNG } = require('vnc-tool/lib/png');

// ── PNG decode/resize helpers ───────────────────────────────────────────────

function decodePNG(buf) {
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

function scaleRGBA(rgba, srcW, srcH, dstW, dstH) {
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

function resizePNG(pngBuf, maxWidth) {
  const { width, height, rgba } = decodePNG(pngBuf);
  if (width <= maxWidth) return pngBuf;
  const dstW   = maxWidth;
  const dstH   = Math.round(height * maxWidth / width);
  const scaled = scaleRGBA(rgba, width, height, dstW, dstH);
  return encodePNG(dstW, dstH, scaled);
}

// ── Coordinate grid overlay ────────────────────────────────────────────────

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

function drawPixel(rgba, w, h, x, y, r, g, b) {
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  const i = (y * w + x) * 4;
  rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = 255;
}

function drawLabel(rgba, w, h, x, y, label, r, g, b) {
  let cx = x;
  for (const ch of String(label)) {
    const d = parseInt(ch, 10);
    if (isNaN(d)) { cx += GLYPH_W + 1; continue; }
    const glyph = DIGIT_GLYPHS[d];
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (glyph[row] & (0b1000 >> col)) {
          drawPixel(rgba, w, h, cx + col, y + row, r, g, b);
        }
      }
    }
    cx += GLYPH_W + 1;
  }
}

function overlayGrid(rgba, w, h, step = 100) {
  const LR = 0, LG = 230, LB = 0;   // grid line color (green)
  const TR = 255, TG = 255, TB = 0;  // text color (yellow)

  const xPositions = [];
  const yPositions = [];
  for (let u = 0; u <= 1000; u += step) {
    xPositions.push({ px: Math.round(u / 1000 * (w - 1)), label: u });
    yPositions.push({ px: Math.round(u / 1000 * (h - 1)), label: u });
  }

  for (const { px: x } of xPositions) {
    for (let y = 0; y < h; y++) drawPixel(rgba, w, h, x, y, LR, LG, LB);
  }
  for (const { px: y } of yPositions) {
    for (let x = 0; x < w; x++) drawPixel(rgba, w, h, x, y, LR, LG, LB);
  }

  for (const { px: gx, label: lx } of xPositions) {
    for (const { px: gy, label: ly } of yPositions) {
      const label = `${lx},${ly}`;
      const lw = label.length * (GLYPH_W + 1);
      for (let bx = gx + 1; bx < gx + 1 + lw && bx < w; bx++) {
        for (let by = gy + 1; by < gy + 1 + GLYPH_H + 2 && by < h; by++) {
          drawPixel(rgba, w, h, bx, by, 0, 0, 0);
        }
      }
      drawLabel(rgba, w, h, gx + 2, gy + 2, label, TR, TG, TB);
    }
  }
}

function overlayGridPNG(pngBuf, gridStep) {
  if (!gridStep) return pngBuf;
  const { width, height, rgba } = decodePNG(pngBuf);
  overlayGrid(rgba, width, height, gridStep);
  return encodePNG(width, height, rgba);
}

// ── Cursor rendering ──────────────────────────────────────────────────────────

/**
 * Draw a mouse cursor pointer on the RGBA buffer.
 * Simple arrow shape: white with black outline for visibility.
 */
function drawCursor(rgba, w, h, cx, cy) {
  // Simple 11x11 pixel arrow cursor shape
  const shape = [
    [1,0,0,0,0,0,0,0,0,0,0],
    [1,1,0,0,0,0,0,0,0,0,0],
    [1,2,1,0,0,0,0,0,0,0,0],
    [1,2,2,1,0,0,0,0,0,0,0],
    [1,2,2,2,1,0,0,0,0,0,0],
    [1,2,2,2,2,1,0,0,0,0,0],
    [1,2,2,2,2,2,1,0,0,0,0],
    [1,2,2,2,2,2,2,1,0,0,0],
    [1,2,2,2,1,1,1,1,1,0,0],
    [1,2,1,1,0,0,0,0,0,0,0],
    [1,1,0,1,1,0,0,0,0,0,0],
  ];
  
  for (let dy = 0; dy < shape.length; dy++) {
    for (let dx = 0; dx < shape[dy].length; dx++) {
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      
      const val = shape[dy][dx];
      if (val === 0) continue; // transparent
      
      const idx = (py * w + px) * 4;
      if (val === 1) {
        // black outline
        rgba[idx] = 0; rgba[idx+1] = 0; rgba[idx+2] = 0; rgba[idx+3] = 255;
      } else if (val === 2) {
        // white fill
        rgba[idx] = 255; rgba[idx+1] = 255; rgba[idx+2] = 255; rgba[idx+3] = 255;
      }
    }
  }
}

/**
 * Render a cursor on a PNG buffer at the given position.
 */
function renderCursorPNG(pngBuf, cursorX, cursorY) {
  const { width, height, rgba } = decodePNG(pngBuf);
  drawCursor(rgba, width, height, cursorX, cursorY);
  return encodePNG(width, height, rgba);
}

module.exports = { resizePNG, overlayGridPNG, decodePNG, scaleRGBA, renderCursorPNG };