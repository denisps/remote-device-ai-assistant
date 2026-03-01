'use strict';

/**
 * Auto-detect which coordinate system the vision model uses.
 *
 * Different VLMs use different conventions:
 *   "norm1000"  – coordinates in 0-1000 range, (0,0)=top-left, (1000,1000)=bottom-right
 *                 regardless of image dimensions. Used by Qwen2-VL / Qwen3-VL.
 *   "pixels"    – coordinates are pixel (x,y) in the image as sent to the model.
 *                 Used by many other models (LLaVA, most GPT-4V usage, etc.)
 *
 * Detection strategy:
 *   Build a synthetic 300×700 white PNG with a bright red square at pixel (75,525),
 *   which corresponds to normalised (250,750). The two coordinate spaces give values
 *   that are clearly distinct, so we can decide which space the model is in.
 */

const zlib = require('zlib');
const { encodePNG } = require('vnc-tool/lib/png');

// Synthetic test image dimensions and target position
const DETECT_W = 300;   // image width  (pixels)
const DETECT_H = 700;   // image height (pixels)

// Red square: pixel centre at (75, 525)  =  norm-1000 (250, 750)
const SQUARE_PX  = 30;  // half-size of the coloured square
const CENTRE_PIX_X = 75;
const CENTRE_PIX_Y = 525;
const CENTRE_NORM_X = Math.round(CENTRE_PIX_X / DETECT_W * 1000); // 250
const CENTRE_NORM_Y = Math.round(CENTRE_PIX_Y / DETECT_H * 1000); // 750

/** Build the synthetic PNG (white background, red square). */
function _buildTestPNG() {
  const rgba = Buffer.alloc(DETECT_W * DETECT_H * 4, 255); // white
  for (let row = CENTRE_PIX_Y - SQUARE_PX; row <= CENTRE_PIX_Y + SQUARE_PX; row++) {
    for (let col = CENTRE_PIX_X - SQUARE_PX; col <= CENTRE_PIX_X + SQUARE_PX; col++) {
      if (row < 0 || row >= DETECT_H || col < 0 || col >= DETECT_W) continue;
      const i = (row * DETECT_W + col) * 4;
      rgba[i] = 220; rgba[i+1] = 30; rgba[i+2] = 30; rgba[i+3] = 255; // red
    }
  }
  return encodePNG(DETECT_W, DETECT_H, rgba);
}

/**
 * Ask the AI to identify the marker position in the test image and return
 * detected coordinate system info.
 *
 * @param {import('./ai').AIClient} ai
 * @returns {Promise<{mode: 'norm1000'|'pixels', details: string}>}
 */
async function detectCoordSystem(ai) {
  const png     = _buildTestPNG();
  const b64     = png.toString('base64');
  const dataUrl = `data:image/png;base64,${b64}`;

  const messages = [
    {
      role: 'system',
      content: 'You are a screen-reading assistant. You will be shown an image and asked to identify a pixel coordinate. Reply ONLY with a JSON object, no other text.',
    },
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: dataUrl },
        },
        {
          type: 'text',
          text: `The image is ${DETECT_W} pixels wide and ${DETECT_H} pixels tall.\nThere is a red square in this image. What are the x and y coordinates of the center of the red square?\nReply ONLY with: {"x": <number>, "y": <number>}`,
        },
      ],
    },
  ];

  let response;
  try {
    response = await ai.chat(messages);
  } catch (e) {
    throw new Error(`AI request failed during coord detection: ${e.message}`);
  }

  // Extract x,y from response
  let x, y;
  try {
    // Try to parse JSON (possibly embedded in text)
    const m = response.match(/\{[^}]*"x"\s*:\s*(\d+)[^}]*"y"\s*:\s*(\d+)[^}]*\}/);
    if (!m) {
      const m2 = response.match(/(\d+)[,\s]+(\d+)/);
      if (!m2) throw new Error('no numbers found');
      x = parseInt(m2[1], 10); y = parseInt(m2[2], 10);
    } else {
      x = parseInt(m[1], 10); y = parseInt(m[2], 10);
    }
  } catch (_) {
    throw new Error(`Could not parse coordinate from AI response: "${response.slice(0, 200)}"`);
  }

  // Tolerance bands
  const normTol  = 120;  // ±120 in 0-1000 space
  const pixTol   = 40;   // ±40 pixels

  const isNorm = Math.abs(x - CENTRE_NORM_X) <= normTol && Math.abs(y - CENTRE_NORM_Y) <= normTol;
  const isPix  = Math.abs(x - CENTRE_PIX_X)  <= pixTol  && Math.abs(y - CENTRE_PIX_Y)  <= pixTol;

  const details = `model returned (${x},${y}); pixel centre=(${CENTRE_PIX_X},${CENTRE_PIX_Y}), norm-1000 centre=(${CENTRE_NORM_X},${CENTRE_NORM_Y})`;

  if (isNorm && !isPix) return { mode: 'norm1000', details };
  if (isPix  && !isNorm) return { mode: 'pixels',  details };

  // Ambiguous or wrong — decide by whichever distance is smaller
  const dNorm = Math.hypot(x - CENTRE_NORM_X, y - CENTRE_NORM_Y);
  const dPix  = Math.hypot(x - CENTRE_PIX_X,  y - CENTRE_PIX_Y);
  const mode  = dNorm <= dPix ? 'norm1000' : 'pixels';
  return { mode, details: `${details} (ambiguous, chose ${mode} by proximity)` };
}

module.exports = { detectCoordSystem };
