'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const http     = require('http');

const { AIClient, AIChat } = require('../lib/ai');

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


test('AIClient: chat() sends tools array when provided', async () => {
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
    const client = new AIClient({ baseUrl: `http://127.0.0.1:${port}/v1` });
    const tools  = [{ type: 'function', function: { name: 'test_fn', parameters: {} } }];
    await client.chat([{ role: 'user', content: 'hi' }], { tools });
    assert.deepEqual(captured.tools, tools, 'tools should be forwarded in the request body');
  } finally {
    await stopServer(server);
  }
});

test('AIClient: chat() with raw=true returns the full message object', async () => {
  const { server, port } = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role:       'assistant',
            content:    null,
            tool_calls: [{ function: { name: 'snap', arguments: '{}' } }],
          },
        }],
      }));
    });
  });

  try {
    const client  = new AIClient({ baseUrl: `http://127.0.0.1:${port}/v1` });
    const message = await client.chat([{ role: 'user', content: 'hi' }], { raw: true });
    assert.equal(message.role, 'assistant');
    assert.ok(Array.isArray(message.tool_calls), 'should expose tool_calls');
    assert.equal(message.tool_calls[0].function.name, 'snap');
  } finally {
    await stopServer(server);
  }
});

// ── AIChat tests ─────────────────────────────────────────────────────────────

test('AIChat: newChat() returns an AIChat instance', () => {
  const client = new AIClient();
  const chat   = client.newChat();
  assert.ok(chat instanceof AIChat);
});

test('AIChat: systemText appends a system message to history', () => {
  const client = new AIClient();
  const chat   = client.newChat();
  chat.systemText('You are a bot.');
  assert.equal(chat._history.length, 1);
  assert.equal(chat._history[0].role, 'system');
  assert.equal(chat._history[0].content, 'You are a bot.');
});

test('AIChat: userText stages a text part', () => {
  const client = new AIClient();
  const chat   = client.newChat();
  chat.userText('hello');
  assert.equal(chat._pending.length, 1);
  assert.equal(chat._pending[0].type, 'text');
  assert.equal(chat._pending[0].text, 'hello');
});

test('AIChat: userImage stages an image_url part as base64 data URL', () => {
  const client = new AIClient();
  const chat   = client.newChat();
  const buf    = Buffer.from([137, 80, 78, 71]); // fake PNG header bytes
  chat.userImage(buf, 'image/png');
  assert.equal(chat._pending.length, 1);
  assert.equal(chat._pending[0].type, 'image_url');
  const url = chat._pending[0].image_url.url;
  assert.ok(url.startsWith('data:image/png;base64,'), 'should be a png data URL');
  assert.equal(url, `data:image/png;base64,${buf.toString('base64')}`);
});

test('AIChat: send() flushes pending as user message and appends assistant reply', async () => {
  const { server, port } = await startMockServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okResponse('reply text'));
    });
  });

  try {
    const client = new AIClient({ baseUrl: `http://127.0.0.1:${port}/v1` });
    const chat   = client.newChat();
    chat.systemText('sys');
    chat.userText('question');

    const reply = await chat.send();
    assert.equal(reply, 'reply text');

    // history should now be: system + user + assistant
    assert.equal(chat._history.length, 3);
    assert.equal(chat._history[1].role, 'user');
    assert.equal(chat._history[1].content, 'question'); // sole text → plain string
    assert.equal(chat._history[2].role, 'assistant');
    assert.equal(chat._history[2].content, 'reply text');

    // pending should be cleared
    assert.equal(chat._pending.length, 0);
  } finally {
    await stopServer(server);
  }
});

test('AIChat: send() with image uses multipart array content', async () => {
  let captured;
  const { server, port } = await startMockServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okResponse('ok'));
    });
  });

  try {
    const client = new AIClient({ baseUrl: `http://127.0.0.1:${port}/v1` });
    const chat   = client.newChat();
    const buf    = Buffer.from('fake-png');
    chat.userImage(buf, 'image/png');
    chat.userText('describe it');
    await chat.send();

    const userMsg = captured.messages.find(m => m.role === 'user');
    assert.ok(Array.isArray(userMsg.content), 'multipart content should be an array');
    assert.ok(userMsg.content.some(p => p.type === 'image_url'), 'should include image_url part');
    assert.ok(userMsg.content.some(p => p.type === 'text' && p.text === 'describe it'));
  } finally {
    await stopServer(server);
  }
});

test('AIChat: send() throws if nothing is staged', async () => {
  const client = new AIClient();
  const chat   = client.newChat();
  await assert.rejects(chat.send(), /no pending user content/);
});

test('AIChat: multi-turn conversation sends full history each time', async () => {
  let callCount = 0;
  let lastMessages;
  const { server, port } = await startMockServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      callCount++;
      lastMessages = JSON.parse(body).messages;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okResponse(`turn ${callCount}`));
    });
  });

  try {
    const client = new AIClient({ baseUrl: `http://127.0.0.1:${port}/v1` });
    const chat   = client.newChat();
    chat.systemText('sys');

    chat.userText('first');
    await chat.send();

    chat.userText('second');
    await chat.send();

    assert.equal(callCount, 2);
    // second call should have: system + user1 + assistant1 + user2 = 4 messages
    assert.equal(lastMessages.length, 4);
    assert.equal(lastMessages[0].role, 'system');
    assert.equal(lastMessages[1].role, 'user');
    assert.equal(lastMessages[2].role, 'assistant');
    assert.equal(lastMessages[3].role, 'user');
  } finally {
    await stopServer(server);
  }
});

test('AIChat: chaining methods returns the same instance', () => {
  const client = new AIClient();
  const chat   = client.newChat();
  const result = chat.systemText('s').userText('u');
  assert.strictEqual(result, chat, 'methods should return `this` for chaining');
});
