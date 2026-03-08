'use strict';


/**
 * Stateful chat session that maintains the full message history (including
 * images and assistant replies) and submits it on every send(). Model
 * runners that implement KV-cache (e.g. llama.cpp, vLLM, Ollama) avoid
 * re-encoding repeated prefix tokens, so keeping full history is both
 * simpler and efficient.
 *
 * Usage:
 *   const chat = client.newChat();
 *   chat.systemText('You are a desktop automation agent.');
 *   chat.userImage(pngBuffer);
 *   chat.userText('Open the browser.');
 *   const reply = await chat.send();
 *   // next turn: add more userImage/userText calls then send() again
 */
class AIChat {
  /** @param {AIClient} client */
  constructor(client) {
    this._client  = client;
    this._history = [];   // committed messages
    this._pending = [];   // staged parts for the next user message
  }

  /**
   * Append a system message to history. Returns `this` for chaining.
   * @param {string} text
   */
  systemText(text) {
    this._history.push({ role: 'system', content: text });
    return this;
  }

  /**
   * Stage a plain-text part for the next user message.
   * Returns `this` for chaining.
   * @param {string} text
   */
  userText(text) {
    this._pending.push({ type: 'text', text });
    return this;
  }

  /**
   * Stage an image for the next user message. `buffer` must be a Buffer
   * containing PNG, JPEG, or another image format the model accepts.
   * The bytes are base64-encoded into a data URL automatically.
   * Returns `this` for chaining.
   *
   * @param {Buffer} buffer    Raw image bytes
   * @param {string} [mimeType='image/png']
   */
  userImage(buffer, mimeType = 'image/png') {
    const url = `data:${mimeType};base64,${buffer.toString('base64')}`;
    this._pending.push({ type: 'image_url', image_url: { url } });
    return this;
  }

  /**
   * Flush all staged (pending) parts as a single user message, send the
   * full history to the model, append the assistant reply to history, and
   * return the reply text.
   *
   * @returns {Promise<string>}
   */
  async send() {
    if (this._pending.length === 0) {
      throw new Error('AIChat.send(): no pending user content to send');
    }

    // Collapse a sole text part to a plain string for maximum model compat.
    const content = this._pending.length === 1 && this._pending[0].type === 'text'
      ? this._pending[0].text
      : this._pending.slice();
    this._history.push({ role: 'user', content });
    this._pending = [];

    const text = await this._client.chat(this._history);
    this._history.push({ role: 'assistant', content: text });
    return text;
  }
}


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
   * Create a new AIChat session backed by this client.
   * @returns {AIChat}
   */
  newChat() {
    return new AIChat(this);
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

module.exports = { AIClient, AIChat };
