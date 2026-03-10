---
description: how to deploy the ag-local-bridge extension locally for development
---

# Local Dev Deploy Workflow

// turbo-all

This workflow deploys the ag-local-bridge source code to the locally installed Antigravity extension directory so changes take effect after a window reload.

## Prerequisites
- The ag-local-bridge extension must be installed in Antigravity (via VSIX or marketplace)
- The repo is at `x:\code\marcodiniz\ag-local-bridge`

## Quick Deploy (Recommended)

1. Run the deploy script:
```
pwsh x:\code\marcodiniz\ag-local-bridge\scripts\dev-deploy.ps1
```

2. In the Antigravity window, reload: `Ctrl+Shift+P` → `Developer: Reload Window`

## What the Deploy Script Does

1. **Syntax checks** all `.js` files under `src/`
2. **Backs up** the old monolithic `extension.js` → `extension.js.bak` (first time only)
3. **Copies** `src/` and `package.json` to the installed extension directory
4. **Verifies** critical files are in place:
   - `package.json` has `"main": "./src/extension.js"`
   - `raw.js` has the 120s inference timeout
   - `rpc.js` has configurable `timeoutMs`
   - `chat.js` imports `callRawInference`

## Important Architecture Notes

### Extension Location
The installed extension lives at:
```
%USERPROFILE%\.antigravity\extensions\<name>-<version>-universal\
```

There may be **multiple versions installed** (e.g. `antigravity-bridge-1.0.0-universal` AND `marcodiniz.ag-local-bridge-1.0.6-universal`). Antigravity loads the **highest version**. The deploy script handles this automatically, but if you manually deploy, check which folder is actually active.

### Module Structure
The extension uses a modular `src/` structure. The old monolithic `extension.js` at the root must be renamed to `.bak` or deleted — otherwise Antigravity may load it instead of `src/extension.js`.

### Key File: `package.json`
The `"main"` field MUST be `"./src/extension.js"`. If you deploy only `src/` without `package.json`, the old `main` (pointing to `./extension.js`) will be used.

### VS Code Configuration Caching
VS Code / Antigravity heavily caches extension configuration defaults. If you change a `"default"` value in `package.json`'s `contributes.configuration`, the old default may persist. To work around this:
- Use `config.inspect('key')` to check if a user override exists
- Or hardcode the default in the handler code itself

### Raw Mode (Brain-Only)
When `agLocalBridge.mode` is `"raw"`, the bridge:
1. Formats all OpenAI messages into a flat prompt string
2. Calls `GetModelResponse` on the sidecar (port discovery → H2+JSON)
3. Parses `<tool_call>` blocks from the response back into OpenAI tool_calls format
4. Returns an OpenAI-compatible response

The `GetModelResponse` RPC takes `{ prompt: string, model: string }` and returns `{ response: string }`.
Model enum values: `MODEL_PLACEHOLDER_M18` (Flash), `MODEL_PLACEHOLDER_M37` (Pro High), `MODEL_PLACEHOLDER_M36` (Pro Low), `MODEL_PLACEHOLDER_M35` (Sonnet), `MODEL_PLACEHOLDER_M26` (Opus).

### Timeout Configuration
- `GetStatus` / quick RPCs: 10s default
- `GetModelResponse` (LLM inference): 120s (set in `raw.js`)
- The `makeH2JsonCall` function in `rpc.js` accepts `timeoutMs` as the 7th parameter
