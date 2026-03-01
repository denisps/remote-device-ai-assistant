'use strict';

/**
 * Auto-detect which coordinate system the vision model uses.
 *
 * Different VLMs use different conventions:
 *   "norm1000"  - coordinates in 0-1000 range, (0,0)=top-left, (1000,1000)=bottom-right
 *                 regardless of image dimensions. Used by Qwen2-VL / Qwen3-VL.
 *   "pixels"    - coordinates are pixel (x,y) in the image as sent to the model.
 *                 Used by many other models (LLaVA, most GPT-4V usage, etc.)
 *
 * Detection strategy:
 *   Use a SMALL image (200x500 px) with a red square near the bottom-right.
 *   Pixel centre:     (150, 375)  = 75% across, 75% down in actual pixels.
 *   Norm-1000 centre: (750, 750)  = 750/1000 in both axes.
 *
 *   The two spaces give values ~300-600 units apart so even a model that is
 *   off by +-150 units will land firmly in one camp.
 *   Decision thresholds: x=450, y=562.
 */

const { encodePNG } = require('vnc-tool/lib/png');

// Tiny image -- keeps the two coordinate spaces maximally apart.
const DETECT_W = 200;   // image width  (actual pixels)
const DETECT_H = 500;   // image height (actual pixels)
const SQUARE_R = 25;    // half-size of the coloured square

// Marker at 75% of each axis in pixel space.
const CENTRE_PIX_X  = Math.round(DETECT_W * 0.75);               // 150
const CENTRE_PIX_Y  = Math.round(DETECT_H * 0.75);               // 375
const CENTRE_NORM_X = Math.round(CENTRE_PIX_X / DETECT_W * 1000); // 750
const CENTRE_NORM_Y = Math.round(CENTRE_PIX_Y / DETECT_H * 1000); // 750

// Midpoint thresholds -- anything below = pixels, anything above = norm1000
const THRESHOLD_X = Math.round((CENTRE_PIX_X + CENTRE_NORM_X) / 2); // 450
const THRESHOLD_Y = Math.round((CENTRE_PIX_Y + CENTRE_NORM_Y) / 2); // 562

/** Build the synthetic PNG (white background, red square at 75%,75%). */
function _buildTestPNG() {
  const rgba = Buffer.alloc(DETECT_W * DETECT_H * 4, 255); // white
  for (let row = CENTRE_PIX_Y - SQUARE_R; row <= CENTRE_PIX_Y + SQUARE_R; row++) {
    for (let col = CENTRE_PIX_X - SQUARE_R; col <= CENTRE_PIX_X + SQUARE_R; col++) {
      if (row < 0 || row >= DETECT_H || col < 0 || col >= DETECT_W) continue;
      const i = (row * DETECT_W + col) * 4;
      rgba[i] = 210; rgba[i+1] = 30; rgba[i+2] = 30; rgba[i+3] = 255; // red
    }
  }
  return encodePNG(DETECT_W, DETECT_H, rgba);
}

/**
 * Ask the AI where the red square is, then classify the coordinate system.
 *
 * @param {import('./ai').AIClient} ai
 * @returns {Promise<{mode: 'norm1000'|'pixels', rawX: number, rawY: number, details: string}>}
 */
async function detectCoordSystem(ai) {
  const png     = _buildTestPNG();
  const b64     = png.toString('base64');
  const dataUrl = `data:image/png;base64,${b64}`;

  const messages = [
    {
      role: 'system',
      content: 'You are a visual assistant. Reply ONLY with a JSON object and no other text.',
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
          text:
            'Look at this image. There is a solid red square somewhere in the image.\n' +
            'Report the x and y coordinates of the CENTER of the red square.\n' +
            'Reply ONLY with this JSON and nothing else: {"x": <number>, "y": <number>}',
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
  let rawX, rawY;
  try {
    const m = response.match(/"x"\s*:\s*(\d+)[^}]*"y"\s*:\s*(\d+)/);
    if (m) {
      rawX = parseInt(m[1], 10); rawY = parseInt(m[2], 10);
    } else {
      const nums = response.match(/(\d+)[,\s]+(\d+)/);
      if (!nums) throw new Error('no numbers found');
      rawX = parseInt(nums[1], 10); rawY = parseInt(nums[2], 10);
    }
  } catch (_) {
    throw new Error(`Could not parse coordinate from model response: "${response.slice(0, 200)}"`);
  }

  // Classify by simple threshold -- large gap (~300-600 units) between the two spaces.
  const modeByX = rawX < THRESHOLD_X ? 'pixels' : 'norm1000';
  const modeByY = rawY < THRESHOLD_Y ? 'pixels' : 'norm1000';

  const details =
    `model returned (${rawX},${rawY}); ` +
    `pixel target=(${CENTRE_PIX_X},${CENTRE_PIX_Y}), ` +
    `norm-1000 target=(${CENTRE_NORM_X},${CENTRE_NORM_Y}), ` +
    `thresholds=(${THRESHOLD_X},${THRESHOLD_Y})`;

  if (modeByX === modeByY) {
    return { mode: modeByX, rawX, rawY, details };
  }

  // X and Y disagree (very unusual) -- pick by overall distance
  const dNorm = Math.hypot(rawX - CENTRE_NORM_X, rawY - CENTRE_NORM_Y);
  const dPix  = Math.hypot(rawX - CENTRE_PIX_X,  rawY - CENTRE_PIX_Y);
  const mode  = dNorm <= dPix ? 'norm1000' : 'pixels';
  return { mode, rawX, rawY, details: `${details} (axes disagreed, chose ${mode} by closest distance)` };
}

module.exports = { detectCoordSystem };
