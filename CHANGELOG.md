# Changelog

All notable changes to the **AG Local Bridge** extension will be documented in this file.

## [1.0.0] - 2026-03-08

### Added

- OpenAI-compatible HTTP API server on `localhost:11435`
- Sidecar process auto-discovery via process inspection
- CSRF token interception from Antigravity's internal traffic
- HTTP/2 ConnectRPC communication with the Antigravity sidecar
- Conversation multiplexing with workspace-aware cascade management
- Automatic workspace context detection from message content
- Support for 6 AI models:
  - Claude Sonnet 4.6 (Thinking) — default
  - Claude Opus 4.6 (Thinking)
  - Gemini 3 Flash
  - Gemini 3.1 Pro (High/Low thinking)
  - GPT-OSS 120B
- Streaming and non-streaming chat completions
- Rate limiting and duplicate message detection
- Concurrency control (max 3 parallel requests)
- 2-tier fallback strategy (Sidecar ConnectRPC → Command Dispatch)
- Status bar indicator with connection status
- Debug endpoints (`/v1/debug`, `/v1/captures`, `/v1/proxy`)
