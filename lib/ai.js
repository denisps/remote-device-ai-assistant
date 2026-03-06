'use strict';


/**
 * Minimal client for any OpenAI-compatible chat/completions API.
 * Uses only Node.js built-in modules.
 */
class AIClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl]    Base URL of the API  (default: http://localhost:11434/v1)
   * @param {string} [options.apiKey]     API key             (default: 'no-key')
   * @param {string} [options.model]      Model name          (default: 'llava')
   * @param {number} [options.timeout]    Request timeout ms  (default: 300000 = 5 min)
   *                                      Local vision models can take 1-3 min on slower hardware.
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || 'http://localhost:11434/v1').replace(/\/$/, '');
    this.apiKey  = options.apiKey  || 'no-key';
    this.model   = options.model   || 'llava';
    this.timeout = options.timeout || 300_000;
  }

  /**
   * Send a chat completion request.
   *
   * @param {Array<{role: string, content: string|Array}>} messages
   * @param {object} [opts]
   * @param {string} [opts.model]        Override model for this call
   * @param {number} [opts.temperature]  Sampling temperature  (default: 0.1)
   * @param {number} [opts.max_tokens]   Maximum tokens to generate (default: 1024)
   * @param {Array}  [opts.tools]        OpenAI-style tool definitions
   * @param {string} [opts.tool_choice]  Tool choice mode (e.g. 'auto')
   * @param {boolean} [opts.raw]          Return the full message object instead of just content
   * @returns {Promise<string|object>}   Assistant reply text, or full message object when raw=true
   */
  async chat(messages, opts = {}) {
    const bodyObj = {
      model:       opts.model       || this.model,
      messages,
      temperature: opts.temperature !== undefined ? opts.temperature : 0.1,
      max_tokens:  opts.max_tokens  || 1024,
      stream:      false,
    };
    if (opts.tools)       bodyObj.tools       = opts.tools;
    if (opts.tool_choice) bodyObj.tool_choice = opts.tool_choice;

    const url      = new URL(`${this.baseUrl}/chat/completions`);
    const response = await this._request(url, bodyObj);

    if (!response.choices || !response.choices[0]) {
      throw new Error('Invalid API response: missing choices');
    }
    const message = response.choices[0].message;
    if (opts.raw) return message;
    return message.content;
  }

  /**
   * Build a user message that contains a screenshot and optional text.
   * Uses the standard OpenAI vision format (image_url content part).
   *
   * @param {Buffer} pngBuffer  Raw PNG bytes
   * @param {string} [text]     Optional text to send alongside the image
   * @returns {{ role: 'user', content: Array }}
   */
  buildImageMessage(pngBuffer, text) {
    const base64 = pngBuffer.toString('base64');
    const content = [
      {
        type:      'image_url',
        image_url: { url: `data:image/png;base64,${base64}` },
      },
    ];
    if (text) {
      content.push({ type: 'text', text });
    }
    return { role: 'user', content };
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  async _request(url, body) {
    // allow callers to pass in an object; stringify centrally so that various
    // helpers don't need to think about it.
    const payload = typeof body === 'string' ? body : JSON.stringify(body);

    // fetch is guaranteed present on our minimum supported Node version
    // (v18+), so we only need the one code path.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(url.href, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: payload,
        signal: controller.signal,
      });
      let parsed;
      try {
        parsed = await res.json();
      } catch (err) {
        // sometimes servers forget the Content-Type header or return plain
        // text; try to parse the raw text as JSON before giving up.
        const raw = await res.text();
        try {
          parsed = JSON.parse(raw);
        } catch (_err) {
          throw new Error(`Failed to parse API response: ${raw.slice(0, 200)}`);
        }
      }
      if (!res.ok) {
        throw new Error(parsed.error?.message || `HTTP ${res.status}`);
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { AIClient };
