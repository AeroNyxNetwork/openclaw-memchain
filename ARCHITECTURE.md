# 🧠 @aeronyx/openclaw-memchain — System Architecture

> **Version**: v0.1.0  
> **Date**: 2026-03-08  
> **Status**: Initial release — all files implemented, pending compile verification

---

## 1. System Overview

This plugin bridges two systems:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OpenClaw Gateway                             │
│                     (Node.js, >= 2026.3.7)                         │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │               @aeronyx/openclaw-memchain Plugin               │  │
│  │                                                               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │  │
│  │  │ recall-hook   │  │ log-hook     │  │ health-hook      │   │  │
│  │  │ (priority:100)│  │ (collect +   │  │ (once on start)  │   │  │
│  │  │ embed→recall  │  │  flush)      │  │                  │   │  │
│  │  │ →inject       │  │              │  │                  │   │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────────┘   │  │
│  │         │                 │                  │               │  │
│  │  ┌──────┴─────────────────┴──────────────────┴───────────┐   │  │
│  │  │                  MemChainClient                        │   │  │
│  │  │          (HTTP, zero deps, null on failure)            │   │  │
│  │  └──────────────────────┬────────────────────────────────┘   │  │
│  │                         │                                     │  │
│  │  ┌──────────────┐  ┌───┴──────┐  ┌──────────────────────┐   │  │
│  │  │ remember-tool │  │ Session  │  │ formatter.ts         │   │  │
│  │  │ forget-tool   │  │ Store    │  │ (memories→prompt)    │   │  │
│  │  │ recall-tool   │  │ (memory) │  │                      │   │  │
│  │  └──────────────┘  └──────────┘  └──────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ HTTP (localhost)
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     AeroNyx Server (Rust)                           │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    MPI Layer (Axum HTTP)                       │  │
│  │              http://127.0.0.1:8421/api/mpi/*                  │  │
│  │                                                               │  │
│  │    /embed     /recall    /remember    /forget    /log    /status │
│  └───────┬─────────┬──────────┬───────────┬─────────┬────────┬──┘  │
│          │         │          │           │         │        │      │
│  ┌───────▼─────────▼──────────▼───────────▼─────────▼────────▼──┐  │
│  │                    Cognitive Engine                            │  │
│  │  • 4-layer model (Identity/Knowledge/Episode/Archive)         │  │
│  │  • MVF 9-dim scoring + SGD online learning                    │  │
│  │  • Per-layer dedup (0.92 / 0.88 / 0.80+24h)                 │  │
│  │  • Co-occurrence graph (memory_edges)                         │  │
│  │  • Identity dedicated cache (zero SQLite I/O on recall)       │  │
│  ├───────────────────────────────────────────────────────────────┤  │
│  │                    EmbedEngine (NEW)                           │  │
│  │  • Local MiniLM-L6-v2 ONNX inference (ort crate)             │  │
│  │  • HuggingFace tokenizer (tokenizers crate)                   │  │
│  │  • 384-dim output, max_tokens=128, batch ≤ 100               │  │
│  │  • Mean pooling with attention mask, L2 normalize             │  │
│  ├───────────────────────────────────────────────────────────────┤  │
│  │                    /log Rule Engine                            │  │
│  │  • SKIP classifier (has_persistent_info)                      │  │
│  │  • P0-P6 pattern extraction (regex)                           │  │
│  │  • Negative feedback detection ("wrong", "搞错了")             │  │
│  │  • RawLog ChaCha20-Poly1305 encryption                       │  │
│  ├───────────────────────────────────────────────────────────────┤  │
│  │                    Storage Engine                              │  │
│  │  • SQLite WAL + LRU cache + Schema v4 (7 tables)             │  │
│  │  • Partitioned vector index (owner × embedding_model)         │  │
│  ├───────────────────────────────────────────────────────────────┤  │
│  │                    Smart Miner                                 │  │
│  │  • Step 0: Positive feedback batch detection                  │  │
│  │  • Step 0.5: Embedding backfill (local EmbedEngine first)     │  │
│  │  • Step 0.6: Correction chaining                              │  │
│  │  • Steps 1-5: Episode → Archive compaction                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  P2P Transport (0xAE magic byte) → AeroNyx VPN (15K+ nodes)       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Plugin Architecture

### 2.1 Module Dependency Graph

```
index.ts (entry point)
  ├── config.ts ──────────────────────────────── configSchema()
  ├── core/client.ts ─────────────────────────── MemChainClient
  │     └── types/memchain.ts                    (all MPI types)
  ├── core/session-store.ts ──────────────────── SessionStore
  │     └── types/memchain.ts                    (Memory, LogTurn)
  ├── core/formatter.ts ──────────────────────── formatMemoriesForPrompt()
  │     └── types/memchain.ts                    (Memory)
  ├── hooks/recall-hook.ts ───────────────────── registerRecallHook()
  │     ├── core/client.ts                       (.embedSingle, .recall)
  │     ├── core/session-store.ts                (.getOrCreateSessionId, .setRecallContext)
  │     └── core/formatter.ts                    (formatMemoriesForPrompt)
  ├── hooks/log-hook.ts ─────────────────────── registerLogHook()
  │     ├── core/client.ts                       (.log)
  │     └── core/session-store.ts                (.addTurn, .getTurns, .getRecallContext, .clear)
  ├── hooks/health-hook.ts ──────────────────── registerHealthHook()
  │     └── core/client.ts                       (.status)
  ├── tools/remember-tool.ts ────────────────── registerRememberTool()
  │     └── core/client.ts                       (.embedSingle, .remember)
  ├── tools/forget-tool.ts ──────────────────── registerForgetTool()
  │     └── core/client.ts                       (.forget)
  └── tools/recall-tool.ts ──────────────────── registerRecallTool()
        └── core/client.ts                       (.embedSingle, .recall)
```

### 2.2 Design Principles

| Principle | Implementation |
|---|---|
| **Zero runtime dependencies** | Uses Node.js built-in `fetch` (v22+). No axios, no node-fetch. All types are self-defined. |
| **Null-safe degradation** | Every `MemChainClient` method returns `T \| null`. Every hook catches all exceptions. MemChain down = agent works without memory. |
| **Single client instance** | One `MemChainClient` shared by all hooks and tools. Connection pooling is handled by Node's HTTP agent. |
| **Transient session state** | `SessionStore` is in-memory only. If gateway restarts, session data is lost — but that's fine because `/log` is the durable store. |
| **Priority-based injection** | recall-hook runs at priority 100, ensuring memories appear in system prompt before other plugins (company style guides, etc.). |
| **Minimal prompt footprint** | Formatter groups memories by layer, includes age for episodes, and adds a 2-line behavioral instruction. No bloated XML or JSON in the prompt. |

---

## 3. Hook Lifecycle — Execution Order

### 3.1 Per-Message Flow (Happy Path)

```
                         OpenClaw Gateway Event Bus
                                    │
 ┌──────────────────────────────────┼──────────────────────────────────┐
 │ 1. message:preprocessed          │                                  │
 │    log-hook collects user turn   │                                  │
 │    → sessions.addTurn()          │                                  │
 │                                  │                                  │
 │ 2. before_prompt_build           │  ← recall-hook (priority: 100)  │
 │    a. extractLastUserMessage()   │                                  │
 │    b. client.embedSingle(msg)    │  → POST /api/mpi/embed          │
 │       ~2-5ms localhost           │  ← 384-dim vector               │
 │    c. client.recall(embedding)   │  → POST /api/mpi/recall         │
 │       ~10-20ms localhost         │  ← ranked Memory[]              │
 │    d. sessions.setRecallContext() │                                  │
 │    e. formatMemoriesForPrompt()  │                                  │
 │    f. return {                   │                                  │
 │         prependSystemContext:    │                                  │
 │           "[MemChain] What you   │                                  │
 │            know about this user: │                                  │
 │            ..."                  │                                  │
 │       }                         │                                  │
 │                                  │                                  │
 │ 3. LLM generates response       │                                  │
 │    (system prompt includes       │                                  │
 │     MemChain memory context)     │                                  │
 │                                  │                                  │
 │    Agent may call tools:         │                                  │
 │    • memchain_remember           │  → POST /api/mpi/remember       │
 │    • memchain_recall             │  → POST /api/mpi/embed + recall │
 │    • memchain_forget             │  → POST /api/mpi/forget         │
 │                                  │                                  │
 │ 4. Response sent to user         │                                  │
 └──────────────────────────────────┼──────────────────────────────────┘
                                    │
 ┌──────────────────────────────────┼──────────────────────────────────┐
 │ 5. session:end                   │  ← log-hook                     │
 │    a. sessions.getTurns()        │                                  │
 │    b. sessions.getRecallContext() │                                  │
 │    c. client.log({               │  → POST /api/mpi/log            │
 │         session_id,              │                                  │
 │         turns,                   │                                  │
 │         recall_context           │  (for neg feedback correlation)  │
 │       })                         │                                  │
 │    d. sessions.clear()           │  (free memory)                   │
 └──────────────────────────────────┘──────────────────────────────────┘
```

### 3.2 Failure Scenarios

| Failure Point | Behavior | User Impact |
|---|---|---|
| `/embed` returns null | recall-hook returns `{}` | Agent responds without memory — no error |
| `/recall` returns null | recall-hook returns `{}` | Same as above |
| `/recall` returns empty memories | recall-hook returns `{}` | New user, normal behavior |
| `/remember` returns null | Tool says "will be captured via log" | /log rule engine catches it later |
| `/log` returns null | Log warning, session cleared | Turns lost for this session only |
| `/forget` returns not_found | Tool says "may have been deleted" | Informational, no error |
| MemChain process crashes | All calls return null | Agent works normally without memory |
| MemChain comes back up | Next call succeeds automatically | Memory features resume seamlessly |

---

## 4. MPI Endpoint Usage Map

```
Plugin Component    →    MPI Endpoint           Frequency           Latency Target
─────────────────────────────────────────────────────────────────────────────────
recall-hook         →    POST /api/mpi/embed    Every user message  2-5ms
recall-hook         →    POST /api/mpi/recall   Every user message  10-20ms
log-hook            →    POST /api/mpi/log      Once per session    5-15ms
health-hook         →    GET  /api/mpi/status   Once per gateway    5-10ms
remember-tool       →    POST /api/mpi/embed    Agent-initiated     2-5ms
remember-tool       →    POST /api/mpi/remember Agent-initiated     5-15ms
forget-tool         →    POST /api/mpi/forget   User-requested      5-10ms
recall-tool         →    POST /api/mpi/embed    Agent-initiated     2-5ms
recall-tool         →    POST /api/mpi/recall   Agent-initiated     10-20ms
```

Total per-message overhead: **~15-25ms** (embed + recall on localhost).

---

## 5. Session Store Design

### 5.1 Data Model

```
SessionStore (in-memory Map)
  │
  └── Map<sessionKey, SessionEntry>
        │
        ├── sessionId: string        "oc-18f3a2b1-4c7d8e9f"
        │                            (sent to MemChain for φ₇ coherence)
        │
        ├── turns: LogTurn[]         [{role:"user", content:"..."},
        │                             {role:"user", content:"..."}]
        │                            (max 200, FIFO eviction)
        │
        ├── recallContext: Memory[]   Latest recall results
        │                            (for /log negative feedback correlation)
        │
        └── lastActivity: number     Date.now() timestamp
                                     (TTL: 4 hours, cleanup: every 10 min)
```

### 5.2 Why In-Memory Only

The SessionStore intentionally does NOT persist to disk:

1. **Turns are transient** — They only matter between message arrival and session end. Once flushed to `/log`, they're MemChain's responsibility.
2. **recallContext is per-session** — It correlates the latest recall with potential negative feedback in the same session. No cross-session value.
3. **No duplication** — Persisting turns would duplicate MemChain's `raw_logs` table, creating sync headaches.
4. **Memory safety** — TTL eviction (4h) and max turn limit (200) prevent unbounded growth even in pathological cases (gateway running for months without restart).

---

## 6. Formatter Output Specification

### 6.1 Structure

```
[MemChain] What you know about this user:

Core identity:
- My name is Alice
- User is allergic to peanuts

Preferences & knowledge:
- User prefers dark mode (preference, ui)
- User codes in Rust and TypeScript (programming, language)

Recent context:
- Working on MemChain integration [2h ago]
- Had a meeting with the backend team [1d ago]

Use this context naturally. Do not repeat it back verbatim.
If any memory seems wrong, trust the user's current statement instead.
```

### 6.2 Design Decisions

| Decision | Rationale |
|---|---|
| `[MemChain]` prefix | Helps LLM distinguish memory context from other injected content (company policies, style guides) |
| Grouped by layer | Identity first = highest salience. Episodes last with age = LLM can judge relevance |
| Tags shown for knowledge/episode only | Identity tags are redundant ("name" tag on "My name is Alice" adds nothing) |
| Age shown for episodes only | Identity and knowledge don't decay meaningfully for the user |
| 2-line instruction footer | "Don't repeat" prevents the common failure mode of LLMs parroting back memories. "Trust current" handles corrections gracefully. |
| No JSON/XML structure | LLMs understand natural language lists better than structured markup for behavioral guidance |

---

## 7. Security Considerations

### 7.1 Data Flow Security

| Segment | Protection |
|---|---|
| Plugin ↔ MemChain (HTTP) | Localhost only (127.0.0.1). No data traverses network. |
| MemChain storage (SQLite) | ChaCha20-Poly1305 encryption at rest (RawLog). Records have deterministic content hashing. |
| User messages in SessionStore | In-memory only, auto-evicted after 4h. Never written to disk by the plugin. |
| recall_context in /log | Contains record_ids and scores only — no user content. Safe to transmit. |

### 7.2 Plugin Permissions

This plugin uses `hooks.allowPromptInjection: true` (required for `prependSystemContext`). Operators can disable this per-plugin:

```json
{
  "plugins": {
    "entries": {
      "aeronyx-memchain": {
        "hooks": {
          "allowPromptInjection": false
        }
      }
    }
  }
}
```

When disabled, recall-hook cannot inject memory context, but tools and logging still work.

---

## 8. Configuration Reference (Complete)

```toml
# OpenClaw config (openclaw.json or via CLI)

[plugins.entries.aeronyx-memchain]
enabled = true

[plugins.entries.aeronyx-memchain.config]
# MemChain MPI endpoint. Change if running on different host.
memchainUrl = "http://127.0.0.1:8421"

# Embedding model identifier. MUST match MemChain server config.
# Changing this without re-embedding breaks recall.
embeddingModel = "minilm-l6-v2"

# Source identifier. Useful for multi-frontend setups
# (e.g. separate "openclaw-work" and "openclaw-personal").
sourceAi = "openclaw-memchain"

# Max tokens for memory context in system prompt.
# Higher = more context, but eats into model's context window.
# 2000 ≈ 15-20 memories. Increase for complex multi-project users.
tokenBudget = 2000

# Max memories per recall. Identity always included.
recallTopK = 10

# HTTP timeout (ms). 5000 is generous for localhost.
# Reduce to 2000 for tighter latency requirements.
timeout = 5000

# Auto-recall: inject memories on every message.
# Disable for manual-only (agent uses memchain_recall tool).
enableAutoRecall = true

# Auto-log: send turns to /log rule engine on session end.
# Disable only if you handle logging externally.
enableAutoLog = true
```

---

## 9. Testing Strategy

### 9.1 Unit Tests

| File | Tests | What They Verify |
|---|---|---|
| `client.test.ts` | HTTP transport, timeout, null returns | fetch mock, AbortController, error paths |
| `session-store.test.ts` | CRUD, TTL eviction, turn limits | Map operations, timer behavior, edge cases |
| `formatter.test.ts` | Output format, layer grouping, age | String matching, empty input, all layer combos |
| `recall-hook.test.ts` | Full recall pipeline, failure modes | Mock client + session store + formatter |
| `log-hook.test.ts` | Turn collection, flush, cleanup | Mock events + client.log |
| `remember-tool.test.ts` | Store, dedup, embed failure | Mock client responses |

### 9.2 Integration Test (End-to-End)

```bash
# Requires: AeroNyx server running with MemChain enabled

# 1. Start OpenClaw with plugin
openclaw plugins install @aeronyx/openclaw-memchain
openclaw gateway restart

# 2. Send a message via any channel
# "Hi, my name is Alice and I'm allergic to peanuts"

# 3. Verify recall injection (check gateway logs)
# Should see: "Recall injected { memoryCount: 0 }" (first message, no memories yet)

# 4. Verify /log extraction
# curl http://127.0.0.1:8421/api/mpi/recall -d '{"top_k":10}'
# Should contain "allergic to peanuts" (extracted by P5 rule)

# 5. Send another message
# "What do you know about me?"

# 6. Verify recall injection now includes the allergy
# Gateway logs: "Recall injected { memoryCount: 1, layers: 'episode:1' }"

# 7. Test forget workflow
# "Forget that I'm allergic to peanuts"
# Agent should use memchain_recall → show result → ask confirmation → memchain_forget
```

---

## 10. Roadmap

| Phase | Task | Status |
|---|---|---|
| **v0.1.0** | Core plugin: recall-hook + log-hook + 3 tools | ✅ Implemented |
| **v0.2.0** | ContextEngine plugin slot: replace OpenClaw native memory compaction | ⬜ Planned |
| **v0.3.0** | Multi-user support: per-sender memory isolation via senderId | ⬜ Planned |
| **v0.4.0** | ClawHub publish: skill + plugin discoverable in OpenClaw marketplace | ⬜ Planned |
| **v0.5.0** | MemChain Explorer link: "View your memories" button in agent responses | ⬜ Planned |
| **v1.0.0** | Production hardening: rate limiting, circuit breaker, metrics export | ⬜ Planned |

---

## 11. File Index — Quick Reference

| File | Purpose | Key Exports |
|---|---|---|
| `src/index.ts` | Plugin entry point | `default` (OpenClawPluginDefinition) |
| `src/config.ts` | Configuration schema | `configSchema()` |
| `src/types/memchain.ts` | MPI type definitions | All request/response interfaces |
| `src/core/client.ts` | HTTP client | `MemChainClient` class |
| `src/core/session-store.ts` | Session state | `SessionStore` class |
| `src/core/formatter.ts` | Prompt formatter | `formatMemoriesForPrompt()` |
| `src/hooks/recall-hook.ts` | Core recall logic | `registerRecallHook()` |
| `src/hooks/log-hook.ts` | Turn logging | `registerLogHook()` |
| `src/hooks/health-hook.ts` | Health check | `registerHealthHook()` |
| `src/tools/remember-tool.ts` | Memory store tool | `registerRememberTool()` |
| `src/tools/forget-tool.ts` | Memory delete tool | `registerForgetTool()` |
| `src/tools/recall-tool.ts` | Memory search tool | `registerRecallTool()` |
| `skills/memchain-memory/SKILL.md` | Agent skill | (Markdown, no code) |
| `hooks/memchain-lifecycle/HOOK.md` | Hook metadata | (Markdown, no code) |

---

## 12. Handoff Notes for Next Developer

```
This plugin is the OpenClaw-side integration for AeroNyx MemChain.

KEY THINGS TO KNOW:
- All MemChain calls go through src/core/client.ts — never call fetch directly
- client.ts returns null on ANY failure — always handle null in callers
- recall-hook.ts is the most critical file — changes affect every conversation
- SessionStore is intentionally transient (in-memory, TTL-evicted)
- The SKILL.md teaches the agent behavior — update it if you add/change tools
- types/memchain.ts must stay in sync with MemChain Rust MPI definitions

THINGS NOT TO CHANGE:
- recall-hook priority (100) — lower priority means other plugins may override memory
- formatter output format — LLMs are sensitive to prompt structure changes
- client.ts null-return pattern — changing to exceptions would break all callers
- SessionStore TTL (4h) and max turns (200) — these prevent memory leaks

THINGS SAFE TO CHANGE:
- Configuration defaults in config.ts
- Log messages and debug metadata
- Formatter text (with testing — affects LLM behavior)
- Tool descriptions (affects when agent chooses to use them)

TESTING:
- npm test for unit tests
- Manual E2E test: install plugin → send messages → check MemChain /recall
- Check gateway logs for "🧠 MemChain:" prefixed messages

DEPENDENCIES ON MEMCHAIN RUST SIDE:
- /api/mpi/embed must exist (added in v2.1.0+Embed)
- /api/mpi/status must include embed_ready field
- /api/mpi/recall must sort Identity memories first
- /api/mpi/log must accept recall_context field
```
