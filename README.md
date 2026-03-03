# remote-device-ai-assistant

An AI assistant that controls a remote desktop over VNC, using any OpenAI-compatible chat API (ollama, llama.cpp, OpenAI, and others).

The agent takes screenshots, sends them to the AI, and executes the returned actions — all with a single `agent.run(task)` call.

## Features

- No production dependencies beyond [vnc-tool](https://github.com/denisps/vnc-tool)

### Performance optimizations (vnc-tool 0.3.0+)

The agent uses vnc-tool's `startScreenBuffering()` API for efficient screen
capture. The screen buffer is initialized once on connect, then all subsequent
screenshot operations are synchronous with no I/O overhead. The buffer's
`updateCount` property enables smart polling that skips unnecessary captures
while waiting for screen updates.
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

### Model compatibility tests

The `test:compat` suite checks whether a specific model has the capabilities the assistant needs:

| Test | What it checks |
|------|----------------|
| `compat/text` | Model responds to a basic text prompt |
| `compat/vision` | Model can identify the colour of a solid-colour image |
| `compat/json-output` | Model follows a JSON-only system instruction |
| `compat/action-format` | Model produces parseable VNC action arrays |
| `compat/tool-calling` | Model handles OpenAI function/tool definitions |
| `compat/ui-identification` | Model can describe a screenshot |
| `compat/prompt-customization` | Model adapts its behaviour to extra context in the system prompt |

```bash
AI_BASE_URL=http://localhost:11434/v1 AI_MODEL=llava npm run test:compat
```

## CLI

`bin/assistant` is an interactive command-line tool for setting up a connection and running tasks.

```bash
node bin/assistant            # interactive setup wizard + demo
node bin/assistant --setup    # re-run the setup wizard
node bin/assistant --demo     # run the wallpaper-change demo
node bin/assistant --task "Open a terminal"
node bin/assistant --help
```

The wizard prompts for:
- AI API endpoint, key, and model — then validates the connection
- VNC host, port, and password — then validates the connection
- Optional lock-screen password (used if the device shows a login screen)

Verified settings are saved to `~/.config/remote-device-assistant/config.json`.

## License

GPL 3.0
