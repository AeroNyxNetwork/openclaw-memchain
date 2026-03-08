---
name: memchain-lifecycle
description: "AeroNyx MemChain session lifecycle management — turn collection, recall context tracking, and conversation log flushing"
homepage: https://github.com/AeroNyx/openclaw-memchain
metadata:
  openclaw:
    emoji: "🧠"
    events:
      - "session:start"
      - "session:end"
      - "message:preprocessed"
    requires:
      plugins: ["aeronyx-memchain"]
---

# MemChain Lifecycle Hook

This hook manages the MemChain session lifecycle within OpenClaw conversations.
It is bundled with the `@aeronyx/openclaw-memchain` plugin and automatically
enabled when the plugin is active.

## What It Does

- **session:start** — Initializes MemChain health check on first session.
  Verifies that the MPI endpoint, vector index, and embedding engine are
  all operational. Logs status report to gateway logs.

- **message:preprocessed** — Collects each inbound user message as a
  conversation turn. Turns are stored in memory and flushed to MemChain's
  /log endpoint when the session ends.

- **session:end** — Batches all collected turns and sends them to
  MemChain's /log rule engine. The engine auto-extracts identities,
  preferences, and allergies (P0-P6 patterns) and detects negative
  feedback for memory correction.

## Requirements

- AeroNyx server must be running with MemChain enabled
- MPI endpoint accessible at the configured URL (default: http://127.0.0.1:8421)
- Plugin `aeronyx-memchain` must be installed and enabled

## Configuration

No separate configuration needed. This hook uses the plugin's config:

```
openclaw config set plugins.entries.aeronyx-memchain.config.memchainUrl "http://127.0.0.1:8421"
openclaw config set plugins.entries.aeronyx-memchain.config.enableAutoLog true
```

## Graceful Degradation

If MemChain is unreachable, all hooks skip silently. OpenClaw continues
to operate normally without memory features. When MemChain becomes
available again, hooks resume automatically on the next message.
