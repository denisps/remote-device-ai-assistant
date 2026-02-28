'use strict';

const https = require('https');
const http  = require('http');

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
   * @param {number} [options.timeout]    Request timeout ms  (default: 60000)
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || 'http://localhost:11434/v1').replace(/\/$/, '');
    this.apiKey  = options.apiKey  || 'no-key';
    this.model   = options.model   || 'llava';
    this.timeout = options.timeout || 60000;
  }

  /**
   * Send a chat completion request.
   *
   * @param {Array<{role: string, content: string|Array}>} messages
   * @param {object} [opts]
   * @param {string} [opts.model]       Override model for this call
   * @param {number} [opts.temperature] Sampling temperature  (default: 0.1)
   * @param {number} [opts.max_tokens]  Maximum tokens to generate (default: 1024)
   * @returns {Promise<string>}  The assistant's reply text
   */
  async chat(messages, opts = {}) {
    const body = JSON.stringify({
      model:       opts.model       || this.model,
      messages,
      temperature: opts.temperature !== undefined ? opts.temperature : 0.1,
      max_tokens:  opts.max_tokens  || 1024,
      stream:      false,
    });

    const url      = new URL(`${this.baseUrl}/chat/completions`);
    const response = await this._request(url, body);

    if (!response.choices || !response.choices[0]) {
      throw new Error('Invalid API response: missing choices');
    }
    return response.choices[0].message.content;
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

  _request(url, body) {
    const isHttps = url.protocol === 'https:';
    const mod     = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          hostname: url.hostname,
          port:     url.port || (isHttps ? 443 : 80),
          path:     url.pathname + url.search,
          method:   'POST',
          headers:  {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Authorization':  `Bearer ${this.apiKey}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            clearTimeout(timer);
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
              const parsed = JSON.parse(raw);
              if (res.statusCode >= 400) {
                reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
              } else {
                resolve(parsed);
              }
            } catch (_) {
              reject(new Error(`Failed to parse API response: ${raw.slice(0, 200)}`));
            }
          });
          res.on('error', (err) => { clearTimeout(timer); reject(err); });
        },
      );

      const timer = setTimeout(() => {
        req.destroy(new Error(`Request timed out after ${this.timeout}ms`));
      }, this.timeout);

      req.on('error', (err) => { clearTimeout(timer); reject(err); });
      req.write(body);
      req.end();
    });
  }
}

module.exports = { AIClient };
