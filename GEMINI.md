# ag-local-bridge — AI Agent Instructions

This file is loaded automatically by AI coding assistants (Gemini, Claude, Cursor, etc.)
and defines the conventions that **must be followed** when making changes to this project.

## Critical: Before Every Commit

**Always run all three checks in order before staging any changes:**

```bash
npm run format       # 1. Auto-fix formatting (Prettier)
npm run lint         # 2. Check for lint errors (ESLint)
npm test             # 3. Run all tests (node:test)
```

Or as a single pipeline:

```bash
npm run format && npm run lint && npm test
```

> **Never skip formatting.** The CI runs `format:check` and will fail if files aren't
> formatted. `npm run format` is non-destructive and safe to run at any time.

## All Available Scripts

| Command                | What it does                                                      |
| ---------------------- | ----------------------------------------------------------------- |
| `npm test`             | Run all tests with Node's built-in test runner                    |
| `npm run lint`         | ESLint over `src/` and `test/`                                    |
| `npm run lint:fix`     | ESLint with auto-fix                                              |
| `npm run format`       | Prettier write (auto-fixes all files)                             |
| `npm run format:check` | Prettier check only (what CI runs)                                |
| `npm run dev:deploy`   | Deploy source to local Antigravity extension (Windows/PowerShell) |

## Code Style

Enforced by **Prettier** (`.prettierrc`) and **ESLint** (`eslint.config.js`).

Key rules:

- Single quotes, trailing commas, semicolons
- 2-space indent, 120-char print width, LF line endings
- `no-unused-vars` → **warn** (prefix with `_` to suppress: `_unused`)
- `eqeqeq` → **error** (always use `===`)
- All files must be `'use strict';` at the top

**Unused imports in new files will produce lint warnings** — remove them before committing.

## Project Structure

```
src/
  extension.js          # VS Code extension entry point
  context.js            # Shared bridge context object
  server.js             # HTTP server setup
  utils.js              # Shared helpers (buildStreamChunk, extractText, log, …)
  models.js             # Model enum → display name mapping + resolveModel()
  images.js             # Image extraction from request content
  workspace.js          # VS Code workspace helpers
  handlers/
    chat.js             # POST /v1/chat/completions
    models.js           # GET /v1/models
    proxy.js            # Generic proxy fallback
    debug.js            # Debug/status endpoints
  interceptors/
    http-server.js      # HTTP/1.1 interception
    https.js            # HTTPS interception
    h2.js               # HTTP/2 interception
  sidecar/
    discovery.js        # Cross-platform sidecar process discovery
    rpc.js              # HTTP/2 JSON RPC calls to sidecar
    cascade.js          # Cascade (chat) RPC helpers
    raw.js              # Raw LLM inference (GetModelResponse bypass)
test/
  setup.js              # Global test setup (VS Code mock loader)
  __mocks__/vscode.js   # VS Code API mock
  *.test.js             # Tests — all use node:test (describe/it/assert)
scripts/
  dev-deploy.ps1        # Local dev deployment script (Windows)
  probe-sidecar.js      # Standalone sidecar RPC probe (dev/debug)
.agents/workflows/
  dev-deploy.md         # /dev-deploy workflow instructions
```

## Testing Conventions

- Use **Node's built-in test runner** (`node:test`) — no Jest, no Mocha.
- Import pattern:
  ```js
  const { describe, it } = require('node:test');
  const assert = require('node:assert/strict');
  ```
- Tests live in `test/*.test.js` and are auto-discovered by `npm test`.
- Mock VS Code API via `test/__mocks__/vscode.js` (loaded by `test/setup.js`).
- **Do not use `console.assert`** — use `assert` from `node:assert/strict`.

## Architecture Notes

### Sidecar Discovery (`src/sidecar/discovery.js`)

Finds the running `language_server_*` process and extracts ports, CSRF tokens,
and cert path. Platform strategies:

- **Windows**: `powershell.exe Get-CimInstance Win32_Process` + `netstat -ano`
- **macOS**: `/bin/ps aux` + `lsof -iTCP -sTCP:LISTEN`
- **Linux**: `/bin/ps aux` + `ss -tlnp`

Binary names per platform:

```js
win32: ['language_server_windows_x64.exe'];
darwin: ['language_server_macos_arm', 'language_server_macos'];
linux: ['language_server_linux'];
```

### Raw Inference Mode (`src/sidecar/raw.js`)

Bypasses Cascade entirely — calls `GetModelResponse` directly on the sidecar.

- Formats OpenAI messages into a flat prompt string with role labels
- Parses `<tool_call>{...}</tool_call>` blocks back into OpenAI `tool_calls` format
- Timeout: **120 seconds** (LLM inference can be slow)
- Model enum values: `MODEL_PLACEHOLDER_M18` (Flash), `MODEL_PLACEHOLDER_M37` (Pro High),
  `MODEL_PLACEHOLDER_M36` (Pro Low), `MODEL_PLACEHOLDER_M35` (Sonnet), `MODEL_PLACEHOLDER_M26` (Opus)

### RPC (`src/sidecar/rpc.js`)

All sidecar calls use HTTP/2 + Connect protocol over `https://localhost:<port>`.
`makeH2JsonCall(port, csrf, certPath, method, body, retries, timeoutMs)`

- Default timeout: 10 000 ms
- For `GetModelResponse`: pass `timeoutMs = 120000`

### CI Pipeline (`.github/workflows/publish.yml`)

Triggers on every push to `master`. Two jobs:

1. **check**: `npm ci` → `lint` → `format:check` → `test`
2. **publish**: auto-versions as `1.1.<run_number>` → packages VSIX → publishes to Open VSX

Version scheme: `1.1.{github.run_number}` — update the `1.1` prefix in the workflow
whenever the base version in `package.json` changes.
