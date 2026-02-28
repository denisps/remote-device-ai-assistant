'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const http     = require('http');

const { AIClient } = require('../lib/ai');

// ── Helpers ─────────────────────────────────────────────────────────────────

function startMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function okResponse(content) {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('AIClient: chat() returns assistant message text', async () => {
  const { server, port } = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      JSON.parse(body); // ensure valid JSON was sent
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okResponse('[{"cmd":"screenshot"}]'));
    });
  });

  try {
    const client = new AIClient({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test' });
    const result = await client.chat([{ role: 'user', content: 'test' }]);
    assert.equal(result, '[{"cmd":"screenshot"}]');
  } finally {
    await stopServer(server);
  }
});

test('AIClient: chat() sends correct model and messages', async () => {
  let captured;
  const { server, port } = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okResponse('ok'));
    });
  });

  try {
    const client = new AIClient({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'llava' });
    await client.chat([{ role: 'user', content: 'hello' }]);
    assert.equal(captured.model, 'llava');
    assert.equal(captured.stream, false);
    assert.equal(captured.messages[0].content, 'hello');
  } finally {
    await stopServer(server);
  }
});

test('AIClient: chat() sends Authorization header', async () => {
  let capturedAuth;
  const { server, port } = await startMockServer((req, res) => {
    capturedAuth = req.headers['authorization'];
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okResponse('ok'));
    });
  });

  try {
    const client = new AIClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
    await client.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(capturedAuth, 'Bearer sk-test');
  } finally {
    await stopServer(server);
  }
});

test('AIClient: chat() throws on HTTP 4xx with error message', async () => {
  const { server, port } = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
    });
  });

  try {
    const client = new AIClient({ baseUrl: `http://127.0.0.1:${port}/v1` });
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }]),
      /Unauthorized/,
    );
  } finally {
    await stopServer(server);
  }
});

test('AIClient: chat() throws when response has no choices', async () => {
  const { server, port } = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x' })); // no choices field
    });
  });

  try {
    const client = new AIClient({ baseUrl: `http://127.0.0.1:${port}/v1` });
    await assert.rejects(
      () => client.chat([{ role: 'user', content: 'hi' }]),
      /missing choices/,
    );
  } finally {
    await stopServer(server);
  }
});

test('AIClient: buildImageMessage() returns correct structure', () => {
  const client = new AIClient({ baseUrl: 'http://localhost/v1' });
  const buf    = Buffer.from('fake-png-data');
  const msg    = client.buildImageMessage(buf, 'what is this?');

  assert.equal(msg.role, 'user');
  assert.ok(Array.isArray(msg.content));

  const imgPart = msg.content.find((p) => p.type === 'image_url');
  assert.ok(imgPart, 'should have an image_url part');
  assert.ok(imgPart.image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(imgPart.image_url.url.slice('data:image/png;base64,'.length),
               buf.toString('base64'));

  const textPart = msg.content.find((p) => p.type === 'text');
  assert.ok(textPart, 'should have a text part');
  assert.equal(textPart.text, 'what is this?');
});

test('AIClient: buildImageMessage() without text omits text part', () => {
  const client = new AIClient({ baseUrl: 'http://localhost/v1' });
  const msg    = client.buildImageMessage(Buffer.from('x'));
  assert.equal(msg.content.length, 1);
  assert.equal(msg.content[0].type, 'image_url');
});
