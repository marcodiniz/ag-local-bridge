# Ag Local Bridge

**Exposes your running [Antigravity](https://codeium.com/antigravity) instance as a local OpenAI-compatible API** on `localhost:11435`.

Use your Antigravity subscription with any tool that speaks OpenAI — [opencode](https://opencode.ai), [aider](https://aider.chat), [continue.dev](https://continue.dev), or plain `curl`.

## How it Works

```
Your tool → HTTP :11435 → VS Code extension → Antigravity sidecar (ConnectRPC) → Cloud AI
```

The extension runs inside Antigravity's VS Code process, discovers the sidecar via process inspection, intercepts CSRF tokens from Antigravity's own traffic, and proxies your requests through the same authenticated channel Antigravity uses internally.

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

1. Locate your Antigravity extensions directory:
   - **Windows**: `%USERPROFILE%\.antigravity\extensions\`
   - **macOS**: `~/.antigravity/extensions/`
   - **Linux**: `~/.antigravity/extensions/`

2. Copy this project into a folder there:
   ```bash
   # Example (Windows)
   git clone https://github.com/marcodiniz/ag-local-bridge "%USERPROFILE%\.antigravity\extensions\ag-local-bridge-1.0.0-universal"
   ```

3. Reload Antigravity (`Ctrl+Shift+P` → *Developer: Reload Window*)

4. Look for **"Ag Local Bridge"** in the Output panel — you should see:
   ```
   ✅ Server running on http://localhost:11435
   ```

## Usage

### With opencode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "ag-bridge": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ag Local Bridge",
      "options": {
        "baseURL": "http://localhost:11435/v1",
        "apiKey": "local"
      },
      "models": {
        "antigravity-claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6 (Antigravity)",
          "limit": { "context": 200000, "output": 64000 }
        },
        "antigravity-gemini-3.1-pro-high": {
          "name": "Gemini 3.1 Pro High (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 }
        },
        "antigravity-gemini-3-flash": {
          "name": "Gemini 3 Flash (Antigravity)",
          "limit": { "context": 1048576, "output": 65536 }
        }
      }
    }
  }
}
```

Then select `ag-bridge/antigravity-claude-sonnet-4-6` as your model.

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
| `GET` | `/v1/debug` | Debug info (sidecar ports, CSRF, captures) |

## Architecture

The extension uses a 3-tier fallback strategy:

1. **Tier 1 — Sidecar ConnectRPC** (preferred): Discovers the Antigravity sidecar process, connects via HTTP/2 with CSRF authentication, and uses the Cascade API (`StartCascade` → `SendUserCascadeMessage` → poll `GetCascadeTrajectory`).

2. **Tier 2 — VS Code Language Model API**: Falls back to `vscode.lm.selectChatModels()` if the sidecar is unavailable.

3. **Tier 3 — Command Dispatch**: Last resort — fires the message through `antigravity.executeCascadeAction`.

## Commands

| Command | Description |
|---------|-------------|
| `Ag Local Bridge: Start Server` | Start the HTTP server |
| `Ag Local Bridge: Stop Server` | Stop the HTTP server |
| `Ag Local Bridge: Show Status` | Display connection status |
| `Ag Local Bridge: Probe Sidecar` | Test sidecar connectivity |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `agLocalBridge.port` | `11435` | HTTP server port |
| `agLocalBridge.logRequests` | `false` | Log request/response details |

## Requirements

- [Antigravity](https://codeium.com/antigravity) installed and running
- Active Antigravity subscription (Pro/Teams/Enterprise)

## License

MIT
