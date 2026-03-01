# API Reference

## `AIClient`

Talks to any OpenAI-compatible `/v1/chat/completions` endpoint.

### Constructor

```js
new AIClient(options)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | string | `http://localhost:11434/v1` | API base URL |
| `apiKey` | string | `'no-key'` | Bearer token (optional for local models) |
| `model` | string | `'llava'` | Model name |
| `timeout` | number | `60000` | Request timeout in milliseconds |

### Methods

#### `chat(messages, [opts])` → `Promise<string|object>`

Send a chat completion request and return the assistant's reply text.

- `messages` — array of `{ role, content }` objects
- `opts.model` — override the model for this request
- `opts.temperature` — sampling temperature (default `0.1`)
- `opts.max_tokens` — max tokens to generate (default `1024`)
- `opts.tools` — OpenAI-style tool/function definitions array
- `opts.tool_choice` — tool choice mode (e.g. `'auto'`)
- `opts.raw` — when `true`, return the full message object instead of just the content string

#### `buildImageMessage(pngBuffer, [text])` → `object`

Build a user message that includes a screenshot as a base64-encoded image, suitable for vision models.

---

## `Agent`

Orchestrates the VNC connection and the AI decision loop.

### Constructor

```js
new Agent(options)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `vnc` | object | `{}` | VNC connection options passed to `VNCClient` |
| `vnc.host` | string | `'localhost'` | VNC server host |
| `vnc.port` | number | `5900` | VNC server port |
| `vnc.password` | string | — | VNC password |
| `vnc.timeout` | number | `10000` | Connection timeout ms |
| `ai` | `AIClient` or object | `{}` | AI client instance or constructor options |
| `systemPrompt` | string | built-in | Override the default system prompt |
| `maxSteps` | number | `10` | Maximum action-cycles before stopping |

### Methods

#### `connect()` → `Promise<void>`

Connect to the VNC server.

#### `disconnect()` → `Promise<void>`

Disconnect from the VNC server.

#### `run(task, [opts])` → `Promise<{steps, result}>`

Run a task described in natural language.

- `task` — what to do on the remote desktop
- `opts.onStep(step, actions)` — optional callback called before each action set is executed
- Returns `{ steps: number, result: string }`

---

## Prompt helpers

### `SYSTEM_PROMPT`

The default system prompt string used by `Agent`.

### `buildTaskMessage(task, [step])` → `string`

Build the user-facing message that accompanies each screenshot. `step` defaults to `1`.

### `createSystemPrompt([opts])` → `string`

Extend the default prompt with extra context or language preference.

| Option | Type | Description |
|--------|------|-------------|
| `extraContext` | string | Additional context appended to the prompt |
| `language` | string | Language code for the result description (e.g. `'fr'`) |

---

## `parseResponse(text)` → `Array | object`

Parse an AI response string into an action array or a `{ done, result }` object.
Handles pure JSON, JSON in markdown code blocks, and JSON embedded in prose.
Throws if no valid JSON is found.

---

## Configuration

### `loadConfig()` → `Promise<object|null>`

Load the saved configuration from disk. Returns `null` if no configuration file exists.

### `saveConfig(config)` → `Promise<void>`

Save a configuration object to disk. Creates the directory if it does not exist.

### `CONFIG_FILE`

Absolute path to the configuration file (`~/.config/remote-device-assistant/config.json`).

The configuration object shape:

```json
{
  "ai": {
    "baseUrl": "http://localhost:11434/v1",
    "apiKey": "no-key",
    "model": "llava"
  },
  "vnc": {
    "host": "192.168.1.10",
    "port": 5900,
    "password": "secret"
  },
  "lockPassword": ""
}
```
