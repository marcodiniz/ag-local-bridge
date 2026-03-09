# AG (Antigravity) Local Bridge

<p align="center">
  <a href="https://open-vsx.org/extension/marcodiniz/ag-local-bridge"><img src="https://img.shields.io/open-vsx/v/marcodiniz/ag-local-bridge?logo=open-vsx&label=Open%20VSX&logoColor=white&color=blueviolet" alt="Open VSX Version"></a>
  <a href="https://open-vsx.org/extension/marcodiniz/ag-local-bridge"><img src="https://img.shields.io/open-vsx/dt/marcodiniz/ag-local-bridge?color=success&label=downloads" alt="Open VSX Downloads"></a>
  <a href="https://github.com/marcodiniz/ag-local-bridge/stargazers"><img src="https://img.shields.io/github/stars/marcodiniz/ag-local-bridge?style=flat&color=gold" alt="GitHub Stars"></a>
  <a href="https://github.com/marcodiniz/ag-local-bridge/issues"><img src="https://img.shields.io/github/issues/marcodiniz/ag-local-bridge" alt="GitHub Issues"></a>
  <a href="https://github.com/marcodiniz/ag-local-bridge/blob/master/LICENSE"><img src="https://img.shields.io/github/license/marcodiniz/ag-local-bridge?style=flat" alt="License"></a>
  <a href="https://buymeacoffee.com/marcowm"><img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-marcowm-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee"></a>
</p>

**Exposes your running [Antigravity](https://codeium.com/antigravity) instance as a local OpenAI-compatible API** on `localhost:11435`.

Use your Antigravity subscription with any tool that speaks OpenAI — [opencode](https://opencode.ai), [aider](https://aider.chat), [continue.dev](https://continue.dev), or plain `curl`.

## How it Works

```
Your tool → HTTP :11435 → VS Code extension → Antigravity sidecar (ConnectRPC) → Cloud AI
```

The extension runs inside Antigravity's VS Code process, discovers the sidecar via process inspection, intercepts CSRF tokens from Antigravity's own traffic, and proxies your requests through the same authenticated channel Antigravity uses internally.

## Features

- **OpenAI-compatible API** — drop-in replacement for any tool expecting OpenAI format
- **Image support** — paste screenshots or attach images from OpenAI clients; images are saved to temp files and referenced in the message so the agent can view them
- **Workspace-aware** — automatically detects and sets the correct project context via `x-workspace-dir` / `x-workspace-uri` headers
- **Conversation multiplexing** — reuses Cascade conversations for efficiency, with automatic retry on capacity errors
- **Streaming & non-streaming** — both modes supported

## Available Models

| Model ID | Description |
|----------|-------------|
| `antigravity-claude-sonnet-4-6` | Claude Sonnet 4.6 with Thinking **(default)** |
| `antigravity-claude-opus-4-6-thinking` | Claude Opus 4.6 with Thinking |
| `antigravity-gemini-3-flash` | Gemini 3 Flash |
| `antigravity-gemini-3.1-pro-high` | Gemini 3.1 Pro — High thinking |
| `antigravity-gemini-3.1-pro-low` | Gemini 3.1 Pro — Low thinking |
| `antigravity-gpt-oss-120b` | GPT-OSS 120B Medium |

## Installation

### From Open VSX (recommended)

1. Open Antigravity
2. Go to **Extensions** (`Ctrl+Shift+X`)
3. Search for **"AG Local Bridge"** by marcodiniz
4. Click **Install**
5. Reload Antigravity (`Ctrl+Shift+P` → *Developer: Reload Window*)

### Manual install

1. Clone into your Antigravity extensions directory:
   ```bash
   # Windows
   git clone https://github.com/marcodiniz/ag-local-bridge "%USERPROFILE%\.antigravity\extensions\ag-local-bridge-1.0.0-universal"

   # macOS / Linux
   git clone https://github.com/marcodiniz/ag-local-bridge ~/.antigravity/extensions/ag-local-bridge-1.0.0-universal
   ```

2. Reload Antigravity (`Ctrl+Shift+P` → *Developer: Reload Window*)

### Verify

Look for **"AG Local Bridge"** in the Output panel — you should see:
```
✅ Server running on http://localhost:11435
```

## Usage

### With opencode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "ag-local-bridge": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AG Local Bridge",
      "options": {
        "baseURL": "http://localhost:11435/v1",
        "apiKey": "local"
      },
      "models": {
        "antigravity-claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6 (Antigravity)",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 200000, "output": 64000 }
        },
        "antigravity-claude-opus-4-6-thinking": {
          "name": "Claude Opus 4.6 Thinking (Antigravity)",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 200000, "output": 64000 }
        },
        "antigravity-gemini-3.1-pro-high": {
          "name": "Gemini 3.1 Pro High (Antigravity)",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 1048576, "output": 65535 }
        },
        "antigravity-gemini-3.1-pro-low": {
          "name": "Gemini 3.1 Pro Low (Antigravity)",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 1048576, "output": 65535 }
        },
        "antigravity-gemini-3-flash": {
          "name": "Gemini 3 Flash (Antigravity)",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 1048576, "output": 65536 }
        },
        "antigravity-gpt-oss-120b": {
          "name": "GPT-OSS 120B Medium (Antigravity)",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 128000, "output": 16384 }
        }
      }
    }
  }
}
```

Then select `ag-local-bridge/antigravity-claude-sonnet-4-6` as your model.

> **Image support**: The `modalities` field enables image input (clipboard paste, file attach). Images are saved to temp files and the agent views them with its built-in file tools.

### With curl

```bash
# List models
curl http://localhost:11435/v1/models

# Chat completion
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "antigravity-claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'

# Streaming
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "antigravity-gemini-3.1-pro-high",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# With image (base64 data URL)
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "antigravity-claude-sonnet-4-6",
    "messages": [{"role": "user", "content": [
      {"type": "text", "text": "What do you see?"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBOR..."}}
    ]}],
    "stream": false
  }'
```

### With any OpenAI-compatible client

```
Base URL: http://localhost:11435/v1
API Key:  anything (not validated)
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completion (streaming & non-streaming) |
| `POST` | `/v1/proxy` | Forward arbitrary RPC to sidecar |
| `GET` | `/v1/debug` | Debug info (sidecar ports, CSRF, captures) |

## Image Support

Images sent via the OpenAI `image_url` content type are handled as follows:

1. **Base64 data URLs** (`data:image/png;base64,...`) — decoded and saved to a temp file
2. **Remote URLs** (`https://...`) — downloaded, then saved to a temp file
3. **File URIs** (`file:///C:/path/to/image.png`) — read directly from disk

The image file path is prepended to the message text so the Antigravity agent can use its `view_file` tool to inspect the image.

## Workspace Context

Pass workspace context via HTTP headers:

| Header | Description |
|--------|-------------|
| `x-workspace-dir` | Absolute filesystem path (e.g. `C:\code\myproject`) |
| `x-workspace-uri` | File URI (e.g. `file:///C:/code/myproject`) |

When set, the bridge switches the active VS Code workspace folder before creating a Cascade, ensuring the agent operates in the correct project context.

## Architecture

The extension uses a 2-tier fallback strategy:

1. **Tier 1 — Sidecar ConnectRPC** (preferred): Discovers the Antigravity sidecar process, connects via HTTP/2 with CSRF authentication, and uses the Cascade API (`StartCascade` → `SendUserCascadeMessage` → poll `GetCascadeTrajectory`). Conversations are multiplexed and the active workspace is auto-detected.

2. **Tier 2 — Command Dispatch**: Last resort — fires the message through `antigravity.executeCascadeAction`.

## Commands

| Command | Description |
|---------|-------------|
| `AG Local Bridge: Start Server` | Start the HTTP server |
| `AG Local Bridge: Stop Server` | Stop the HTTP server |
| `AG Local Bridge: Show Status` | Display connection status |
| `AG Local Bridge: Probe Sidecar` | Test sidecar connectivity |
| `AG Local Bridge: List Available LM Models` | List configured models and sidecar status |
| `AG Local Bridge: List Available Chat Commands (Debug)` | List chat commands available for debugging |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `agLocalBridge.port` | `11435` | HTTP server port |
| `agLocalBridge.logRequests` | `false` | Log request/response details |

## Requirements

- [Antigravity](https://codeium.com/antigravity) installed and running
- Active Antigravity subscription (Free/Pro/Teams/Enterprise)

## License

MIT
