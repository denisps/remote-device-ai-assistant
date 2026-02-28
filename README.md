# remote-device-ai-assistant

An AI assistant that controls a remote desktop over VNC, using any OpenAI-compatible chat API (ollama, llama.cpp, OpenAI, and others).

The agent takes screenshots, sends them to the AI, and executes the returned actions — all with a single `agent.run(task)` call.

## Features

- No production dependencies beyond [vnc-tool](https://github.com/denisps/vnc-tool)
- Works with local vision models via [ollama](https://ollama.com) or [llama.cpp](https://github.com/ggerganov/llama.cpp)
- System prompt is short, easy to read, and easy to customise
- Pure Node.js ≥ 18 — no native modules, no build step

## Install

```bash
git clone https://github.com/denisps/remote-device-ai-assistant
cd remote-device-ai-assistant
npm install
```

## Quick start

```js
const { Agent } = require('./lib');

const agent = new Agent({
  vnc: { host: '192.168.1.10', password: 'secret' },
  ai:  { baseUrl: 'http://localhost:11434/v1', model: 'llava' },
});

await agent.connect();
const { steps, result } = await agent.run('Open a terminal and type "echo hello"');
console.log(`Done in ${steps} steps: ${result}`);
await agent.disconnect();
```

## Configuration

`Agent` accepts two main option groups:

**`vnc`** — passed directly to the VNC client:

| Key | Default | Description |
|-----|---------|-------------|
| `host` | `'localhost'` | VNC server hostname or IP |
| `port` | `5900` | VNC port |
| `password` | — | VNC password (optional) |
| `timeout` | `10000` | Connection timeout ms |

**`ai`** — passed to `AIClient`:

| Key | Default | Description |
|-----|---------|-------------|
| `baseUrl` | `http://localhost:11434/v1` | API base URL |
| `apiKey` | `'no-key'` | Bearer token (not needed for local models) |
| `model` | `'llava'` | Model name |
| `timeout` | `60000` | Request timeout ms |

Additional `Agent` options:

| Key | Default | Description |
|-----|---------|-------------|
| `systemPrompt` | built-in | Replace the default system prompt |
| `maxSteps` | `10` | Stop after this many action-cycles |

## Customising prompts

The built-in system prompt is in `lib/prompts.js`. You can pass your own string:

```js
const { createSystemPrompt } = require('./lib');

const agent = new Agent({
  systemPrompt: createSystemPrompt({ extraContext: 'This machine runs Windows 11' }),
  // ...
});
```

See [docs/api.md](docs/api.md) for the full API reference.

## Using a local model

With [ollama](https://ollama.com):

```bash
ollama pull llava
ollama serve
```

Then set `baseUrl: 'http://localhost:11434/v1'` and `model: 'llava'`.

With [llama.cpp](https://github.com/ggerganov/llama.cpp), start the server with a vision-capable GGUF model and point `baseUrl` at its `/v1` endpoint.

## Testing

Unit tests run without any VNC server or AI API:

```bash
npm test
npm run test:verbose   # detailed output
```

Integration tests connect to a real device and/or a real API. Set environment variables to activate them:

| Variable | Description |
|----------|-------------|
| `VNC_HOST` | VNC server host (activates VNC tests) |
| `VNC_PORT` | VNC port (default: `5900`) |
| `VNC_PASSWORD` | VNC password |
| `AI_BASE_URL` | API base URL (activates AI tests) |
| `AI_API_KEY` | API key |
| `AI_MODEL` | Model name (default: `llava`) |

```bash
VNC_HOST=192.168.1.10 AI_BASE_URL=http://localhost:11434/v1 npm run test:integration
```

## License

MIT
