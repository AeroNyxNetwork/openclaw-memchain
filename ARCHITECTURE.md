# 🧠 @aeronyx/openclaw-memchain — System Architecture

> **Version**: v0.3.1  
> **Date**: 2026-03-29  
> **Status**: v0.3.1 code review complete — 11 bugs fixed, pending full regression test

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
│  │  ┌──────────────┐  ┌──────────────────────┐  ┌────────────┐  │  │
│  │  │ recall-hook  │  │ log-hook             │  │health-hook │  │  │
│  │  │ (priority:   │  │ message:preprocessed │  │(once on    │  │  │
│  │  │  100)        │  │ → user turn (NEW)    │  │ start)     │  │  │
│  │  │ embed→recall │  │ message:response     │  │            │  │  │
│  │  │ →inject      │  │ → assistant turn     │  │            │  │  │
│  │  │              │  │ session:end → /log   │  │            │  │  │
│  │  └──────┬───────┘  └──────┬───────────────┘  └──────┬─────┘  │  │
│  │         │                 │                          │        │  │
│  │  ┌──────┴─────────────────┴──────────────────────────┴─────┐  │  │
│  │  │                    MemChainClient                        │  │  │
│  │  │  local / remote (Ed25519+E2E) / cloud (CMS relay+E2E)   │  │  │
│  │  │         (HTTP, zero deps, null on failure)               │  │  │
│  │  └──────────────────────┬───────────────────────────────────┘  │  │
│  │                         │                                       │  │
│  │  ┌──────────────┐  ┌────┴─────┐  ┌──────────────────────┐     │  │
│  │  │remember-tool │  │ Session  │  │ formatter.ts         │     │  │
│  │  │forget-tool   │  │ Store    │  │ (memories→prompt)    │     │  │
│  │  │recall-tool   │  │ (memory) │  │                      │     │  │
│  │  │search-tool   │  └──────────┘  └──────────────────────┘     │  │
│  │  │replay-tool   │                                              │  │
│  │  └──────────────┘                                              │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ HTTP (localhost / remote node / CMS relay)
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     AeroNyx Server (Rust) v2.5.0                    │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    MPI Layer (Axum HTTP)                       │  │
│  │              http://127.0.0.1:8421/api/mpi/*                  │  │
│  │                                                               │  │
│  │  /embed   /recall   /remember   /forget   /log   /status     │  │
│  │  /search  /context/inject  /sessions/:id                     │  │
│  │  /sessions/:id/conversation  /projects  /entities            │  │
│  │  /communities  (29 endpoints total)                          │  │
│  └───────┬─────────┬──────────┬───────────┬─────────┬──────────┘  │
│          │         │          │           │         │              │
│  ┌───────▼─────────▼──────────▼───────────▼─────────▼──────────┐  │
│  │                    Cognitive Engine                           │  │
│  │  • 4-layer model (Identity/Knowledge/Episode/Archive)        │  │
│  │  • MVF 9-dim scoring + SGD online learning                   │  │
│  │  • Per-layer dedup (0.92 / 0.88 / 0.80+24h)                │  │
│  │  • Co-occurrence graph (memory_edges)                        │  │
│  │  • Identity dedicated cache (zero SQLite I/O on recall)      │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │                    EmbedEngine                                │  │
│  │  • Local MiniLM-L6-v2 ONNX inference (ort crate)            │  │
│  │  • HuggingFace tokenizer (tokenizers crate)                  │  │
│  │  • 384-dim output, max_tokens=128, batch ≤ 100              │  │
│  │  • Mean pooling with attention mask, L2 normalize            │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │                    /log Rule Engine                           │  │
│  │  • SKIP classifier (has_persistent_info)                     │  │
│  │  • P0-P6 pattern extraction (regex)                          │  │
│  │  • Negative feedback detection ("wrong", "搞错了")            │  │
│  │  • RawLog ChaCha20-Poly1305 encryption                      │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │                    NER + Knowledge Graph (v2.5.0)            │  │
│  │  • Named entity recognition (ner_ready)                      │  │
│  │  • Entity relationship graph (graph_enabled)                 │  │
│  │  • Community detection                                       │  │
│  │  • SuperNode background enhancement                          │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │                    Storage Engine                             │  │
│  │  • SQLite WAL + LRU cache + Schema v4 (7 tables)            │  │
│  │  • Partitioned vector index (owner × embedding_model)        │  │
│  │  • BM25 full-text search index                               │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │                    Smart Miner                                │  │
│  │  • Step 0: Positive feedback batch detection                 │  │
│  │  • Step 0.5: Embedding backfill (local EmbedEngine first)    │  │
│  │  • Step 0.6: Correction chaining                             │  │
│  │  • Steps 1-5: Episode → Archive compaction                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
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
  │     ├── core/client.ts          (.embedSingle, .recall, .getContextInjection)
  │     ├── core/session-store.ts   (.getOrCreateSessionId, .setRecallContext)
  │     └── core/formatter.ts       (formatMemoriesForPrompt)
  ├── hooks/log-hook.ts ──────────────────────── registerLogHook()
  │     ├── core/client.ts          (.log)
  │     └── core/session-store.ts   (.addTurn, .getTurns, .getRecallContext,
  │                                  .markOverflowWarned, .clear)
  ├── hooks/health-hook.ts ────────────────────── registerHealthHook()
  │     └── core/client.ts          (.status)
  ├── tools/remember-tool.ts ─────────────────── registerRememberTool()
  │     └── core/client.ts          (.embedSingle, .remember)
  ├── tools/forget-tool.ts ───────────────────── registerForgetTool()
  │     └── core/client.ts          (.forget)
  ├── tools/recall-tool.ts ───────────────────── registerRecallTool()
  │     └── core/client.ts          (.embedSingle, .recall)
  ├── tools/search-tool.ts ───────────────────── registerSearchTool()
  │     └── core/client.ts          (.search)
  └── tools/replay-tool.ts ───────────────────── registerReplayTool()
        └── core/client.ts          (.getConversation, .getSession)
```

### 2.2 Three-Mode Architecture (v0.3.0+)

| Feature | Local | Remote | Cloud |
|---|---|---|---|
| Data path | Plugin → localhost | Plugin → node IP | Plugin → CMS → node |
| CMS auth | — | — | Bearer token (sk-xxx) |
| Node auth | Bearer token | Ed25519 signature | Ed25519 (CMS transparent) |
| Content encryption | Plaintext | E2E (ChaCha20) | E2E (ChaCha20) |
| /log rule engine | ✅ | ❌ (403) | ❌ (403) |
| Memory extraction | Auto + manual | Manual only | Manual only |

### 2.3 Design Principles

| Principle | Implementation |
|---|---|
| **Zero runtime dependencies** | Uses Node.js built-in `fetch` (v22+). No axios, no node-fetch. All types are self-defined. |
| **Null-safe degradation** | Every `MemChainClient` method returns `T \| null`. Every hook catches all exceptions. MemChain down = agent works without memory. |
| **Single client instance** | One `MemChainClient` shared by all hooks and tools. Connection pooling handled by Node's HTTP agent. |
| **Transient session state** | `SessionStore` is in-memory only. If gateway restarts, session data is lost — `/log` is the durable store. |
| **Priority-based injection** | recall-hook runs at priority 100, ensuring memories appear before other plugins. |
| **Minimal prompt footprint** | Formatter groups memories by layer with age indicators. No bloated XML or JSON in the prompt. |
| **Mode-delegated filtering** | log-hook never checks mode — all mode logic lives in `client.log()` to prevent double-suppression bugs. |

---

## 3. Hook Lifecycle — Execution Order

### 3.1 Per-Message Flow (v0.3.1 — Happy Path)

```
                         OpenClaw Gateway Event Bus
                                    │
 ┌──────────────────────────────────┼──────────────────────────────────┐
 │ 1. message:preprocessed          │  ← log-hook (user turn)         │
 │    Fires BEFORE LLM responds     │                                  │
 │    → sessions.addTurn("user")    │                                  │
 │                                  │                                  │
 │ 2. before_prompt_build           │  ← recall-hook (priority: 100)  │
 │    a. extractLastUserMessage()   │                                  │
 │    b. client.getContextInjection()→ GET /api/mpi/context/inject    │
 │       (optional, v2.5.0+)        │  ← project + sessions + entities│
 │    c. client.embedSingle(msg)    │  → POST /api/mpi/embed          │
 │       ~2-5ms localhost           │  ← 384-dim vector               │
 │    d. client.recall({            │  → POST /api/mpi/recall         │
 │         embedding,               │                                  │
 │         query: userMessage })    │  ← ranked Memory[]              │
 │    e. sessions.setRecallContext() │                                  │
 │    f. formatMemoriesForPrompt()  │                                  │
 │    g. return {                   │                                  │
 │         prependSystemContext:    │                                  │
 │           serverContext +        │                                  │
 │           "[MemChain] What you   │                                  │
 │            know about this user: │                                  │
 │            ..."                  │                                  │
 │       }                          │                                  │
 │                                  │                                  │
 │ 3. LLM generates response        │                                  │
 │    (system prompt includes       │                                  │
 │     MemChain memory context)     │                                  │
 │                                  │                                  │
 │    Agent may call tools:         │                                  │
 │    • memchain_remember           │  → POST /api/mpi/remember       │
 │    • memchain_recall             │  → POST /api/mpi/embed + recall │
 │    • memchain_forget             │  → POST /api/mpi/forget         │
 │    • memchain_search             │  → GET  /api/mpi/search         │
 │    • memchain_replay             │  → GET  /api/mpi/sessions/:id/  │
 │                                  │         conversation            │
 │ 4. Response sent to user         │                                  │
 │                                  │                                  │
 │ 5. message:response              │  ← log-hook (assistant turn)    │
 │    Fires AFTER LLM responds      │  ⚠️ NEW in v0.3.1               │
 │    → sessions.addTurn            │                                  │
 │        ("assistant")             │                                  │
 └──────────────────────────────────┼──────────────────────────────────┘
                                    │
 ┌──────────────────────────────────┼──────────────────────────────────┐
 │ 6. session:end                   │  ← log-hook                     │
 │    a. sessions.getTurns()        │     (now contains user          │
 │       → [user + assistant turns] │      + assistant turns)         │
 │    b. sessions.getRecallContext() │                                  │
 │    c. client.log({               │  → POST /api/mpi/log            │
 │         session_id,              │     (local mode only;           │
 │         turns,                   │      remote/cloud: null)        │
 │         recall_context           │                                  │
 │       })                         │                                  │
 │    d. sessions.clear()           │                                  │
 └──────────────────────────────────┴──────────────────────────────────┘
```

### 3.2 Failure Scenarios

| Failure Point | Behavior | User Impact |
|---|---|---|
| `/context/inject` fails | log.debug + continue | No project context, recall still works |
| `/embed` returns null | recall-hook returns server context only | Agent has project context, no semantic memories |
| `/recall` returns null | recall-hook returns `{}` | Agent responds without memory — no error |
| `/recall` returns empty | recall-hook returns server context only | New user, normal behavior |
| `/remember` returns null | Tool says "will be captured via log" | /log rule engine catches it later |
| `/log` returns null (local) | log.warn, session cleared | Turns lost for this session only |
| `/log` skipped (remote/cloud) | log.debug, session cleared | Expected — use memchain_remember tool |
| `/forget` returns not_found | Tool says "may have been deleted" | Informational, no error |
| Session exceeds 200 turns | log.warn once, oldest turn dropped | Long sessions lose oldest turns |
| MemChain process crashes | All calls return null | Agent works normally without memory |
| MemChain comes back up | Next call succeeds automatically | Memory features resume seamlessly |

---

## 4. MPI Endpoint Usage Map

```
Plugin Component    →    MPI Endpoint                    Frequency           Latency Target
──────────────────────────────────────────────────────────────────────────────────────────
recall-hook         →    GET  /api/mpi/context/inject    Every message       5-15ms
recall-hook         →    POST /api/mpi/embed             Every user message  2-5ms
recall-hook         →    POST /api/mpi/recall            Every user message  10-20ms
log-hook            →    POST /api/mpi/log               Once per session    5-15ms
health-hook         →    GET  /api/mpi/status            Once per gateway    5-10ms
remember-tool       →    POST /api/mpi/embed             Agent-initiated     2-5ms
remember-tool       →    POST /api/mpi/remember          Agent-initiated     5-15ms
forget-tool         →    POST /api/mpi/forget            User-requested      5-10ms
recall-tool         →    POST /api/mpi/embed             Agent-initiated     2-5ms
recall-tool         →    POST /api/mpi/recall            Agent-initiated     10-20ms
search-tool         →    GET  /api/mpi/search            Agent-initiated     5-15ms
replay-tool         →    GET  /api/mpi/sessions/:id/     Agent-initiated     10-30ms
                              conversation
replay-tool         →    GET  /api/mpi/sessions/:id      Agent-initiated     5-10ms
```

Total per-message overhead: **~20-40ms** (context/inject + embed + recall on localhost).

---

## 5. Session Store Design

### 5.1 Data Model

```
SessionStore (in-memory Map)
  │
  └── Map<sessionKey, SessionEntry>
        │
        ├── sessionId: string         "oc-18f3a2b1-4c7d8e9f"
        │                             (sent to MemChain for φ₇ coherence)
        │
        ├── turns: LogTurn[]          [{role:"user",      content:"..."},
        │                              {role:"assistant", content:"..."},
        │                              {role:"user",      content:"..."},
        │                              ...]
        │                             (max 200, FIFO eviction with warn-once)
        │
        ├── recallContext: Memory[]   Latest recall results
        │                             (for /log negative feedback correlation)
        │
        ├── lastActivity: number      Date.now() timestamp
        │                             (TTL: 4 hours, cleanup: every 10 min)
        │
        └── hasWarnedOverflow: bool   Prevents repeated warn logs when
                                      session exceeds 200-turn cap (v0.3.1)
```

### 5.2 Turn Collection — Hook Timing (v0.3.1 fix)

```
message:preprocessed  → fires BEFORE LLM responds
  Only collect user turns here.
  event.context.responseText is always undefined at this point.

message:response      → fires AFTER LLM responds
  Collect assistant turns here.
  event.context.responseText contains the LLM's reply.

⚠️ CRITICAL: Never read responseText in message:preprocessed.
   The previous v0.3.0 code attempted this and always got undefined,
   resulting in /log receiving only user-side turns. The rule engine
   requires both sides to detect entities and negative feedback correctly.
```

### 5.3 Why In-Memory Only

The SessionStore intentionally does NOT persist to disk:

1. **Turns are transient** — They only matter between message arrival and session end. Once flushed to `/log`, they're MemChain's responsibility.
2. **recallContext is per-session** — It correlates the latest recall with potential negative feedback in the same session. No cross-session value.
3. **No duplication** — Persisting turns would duplicate MemChain's `raw_logs` table, creating sync headaches.
4. **Memory safety** — TTL eviction (4h) and max turn limit (200) prevent unbounded growth even if gateway runs for months without restart.

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

When `/context/inject` is available (v2.5.0+), server context is prepended:

```
## Project: Alpha
Status: active

### Recent Sessions
- Session 1: MemChain plugin integration (2h ago)
- Session 2: JWT auth implementation (1d ago)

### Key Entities
- JWT, ring crate, Ed25519

[MemChain] What you know about this user:
...
```

### 6.2 Design Decisions

| Decision | Rationale |
|---|---|
| `[MemChain]` prefix | Helps LLM distinguish memory context from other injected content |
| Grouped by layer | Identity first = highest salience. Episodes last with age = LLM can judge relevance |
| Tags shown for knowledge/episode only | Identity tags are redundant ("name" tag on "My name is Alice" adds nothing) |
| Age shown for episodes only | Identity and knowledge don't decay meaningfully for the user |
| 2-line instruction footer | "Don't repeat" prevents LLMs parroting back memories. "Trust current" handles corrections gracefully. |
| No JSON/XML structure | LLMs understand natural language lists better than structured markup for behavioral guidance |
| Server context prepended | Project/entity context from `/context/inject` provides richer grounding before memory list |

---

## 7. Security Considerations

### 7.1 Data Flow Security

| Segment | Protection |
|---|---|
| Plugin ↔ MemChain local (HTTP) | Localhost only (127.0.0.1). No data traverses network. |
| Plugin ↔ MemChain remote | Ed25519 request signing + ChaCha20-Poly1305 E2E encryption |
| Plugin ↔ CMS ↔ MemChain cloud | Bearer token (CMS) + Ed25519 sign (node) + ChaCha20 E2E |
| MemChain storage (SQLite) | ChaCha20-Poly1305 encryption at rest (RawLog). Deterministic content hashing. |
| User messages in SessionStore | In-memory only, auto-evicted after 4h. Never written to disk by the plugin. |
| recall_context in /log | Contains record_ids and scores only — no user content. Safe to transmit. |

### 7.2 Key Management (Remote + Cloud Modes)

```
~/.openclaw/memchain-keys.json   (permissions: 600)
  ├── privateKey: hex            Ed25519 private key
  ├── publicKey: hex             Ed25519 public key
  └── createdAt: ISO8601         Key generation timestamp

Record encryption key derived via HKDF:
  recordKey = HKDF(sha256, privateKey, "memchain-records", "v1", 32 bytes)
```

### 7.3 Plugin Permissions

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
# Operating mode: "local" (default), "remote", or "cloud"
mode = "local"

# MemChain MPI endpoint. Used in local mode only.
memchainUrl = "http://127.0.0.1:8421"

# Remote MemChain node URL. Used in remote mode only.
nodeUrl = ""

# AeroNyx CMS relay URL. Used in cloud mode only.
cmsUrl = "https://api.aeronyx.network"

# Bearer token for CMS auth (sk-xxx). Required in cloud mode.
apiKey = ""

# Ed25519 key pair file. Auto-generated on first remote/cloud startup.
keyStorePath = "~/.openclaw/memchain-keys.json"

# Embedding model. MUST match MemChain server config.
# Changing this without re-embedding breaks recall.
embeddingModel = "minilm-l6-v2"

# Source identifier. Useful for multi-frontend setups.
sourceAi = "openclaw-memchain"

# Max tokens for memory context in system prompt.
# 2000 ≈ 15-20 memories. Increase for complex multi-project users.
tokenBudget = 2000

# Max memories per recall. Identity always included.
recallTopK = 10

# HTTP timeout (ms). 5000 is generous for localhost.
timeout = 5000

# Auto-recall: inject memories on every message.
enableAutoRecall = true

# Auto-log: send turns to /log rule engine on session end.
# Note: disabled automatically in remote/cloud modes (403).
enableAutoLog = true
```

---

## 9. Testing Strategy

### 9.1 Unit Tests

| File | Tests | What They Verify |
|---|---|---|
| `client.test.ts` | HTTP transport, timeout, null returns, mode routing | fetch mock, AbortController, error paths, Ed25519 sign |
| `session-store.test.ts` | CRUD, TTL eviction, turn limits, overflow warning | Map operations, timer behavior, edge cases, hasWarnedOverflow |
| `formatter.test.ts` | Output format, layer grouping, age | String matching, empty input, all layer combos |
| `recall-hook.test.ts` | Full recall pipeline, context/inject, failure modes | Mock client + session store + formatter |
| `log-hook.test.ts` | User + assistant turn collection, flush, cleanup | Mock events (preprocessed + response + end) + client.log |
| `remember-tool.test.ts` | Store, dedup, embed failure | Mock client responses |
| `forget-tool.test.ts` | Delete, not_found, execute signature | Two-arg execute, mock client |
| `search-tool.test.ts` | Keyword search, mark tag replacement | Regex correctness, result formatting |
| `replay-tool.test.ts` | Session replay, encrypted turns, max_turns | Mock client, turn truncation |

### 9.2 Integration Test (End-to-End)

```bash
# Requires: AeroNyx server running with MemChain enabled

# 1. Build and install
npm run build
openclaw plugins install -l /home/openclaw/openclaw-memchain
openclaw gateway restart

# 2. Send a message via any channel
# "Hi, my name is Alice and I'm allergic to peanuts"

# 3. Verify /log received BOTH user and assistant turns (v0.3.1 fix)
curl -s "http://127.0.0.1:8421/api/mpi/sessions/<session_id>/conversation" \
  | jq '.turns[] | {role, content: .content[:60]}'
# Expected: role=user AND role=assistant entries

# 4. Verify /log extraction
curl -s -X POST http://127.0.0.1:8421/api/mpi/recall \
  -H 'Content-Type: application/json' \
  -d '{"top_k":10}' | jq '.memories[] | {layer, content}'
# Expected: allergy memory in identity layer

# 5. Verify forget tool works (v0.3.1 fix)
# Agent should call: memchain_recall → show ID → memchain_forget(record_id)
# Previously broken: record_id was always undefined due to missing execute arg

# 6. Verify search result formatting
# Agent: memchain_search({ query: "peanut" })
# Expected: **bold** highlights, not broken "** **" markers

# 7. Gateway log verification
tail -f /tmp/openclaw-999/openclaw-$(date +%Y-%m-%d).log | grep MemChain
# Expected log levels (v0.3.1):
#   [debug] recall started, embed OK, Turn collected
#   [info]  context/inject OK, recall OK, INJECTING, Session logged
#   [warn]  only on actual degraded conditions
```

---

## 10. Roadmap

| Phase | Task | Status |
|---|---|---|
| **v0.1.0** | Core plugin: recall-hook + log-hook + 3 tools | ✅ Done |
| **v0.2.0** | Remote mode: Ed25519 + ChaCha20 E2E encryption | ✅ Done |
| **v0.3.0** | Cloud mode + search/replay tools + /context/inject | ✅ Done |
| **v0.3.1** | Code review: 11 bug fixes across 9 files | ✅ Done |
| **v0.3.1** | Full regression test (local + remote + cloud) | ⬜ Next |
| **v0.4.0** | Progressive retrieval (mode=index + /recall/detail) | ⬜ Planned |
| **v0.4.0** | ContextEngine slot: replace native OpenClaw compaction | ⬜ Planned |
| **v0.5.0** | memchain_explore: knowledge graph browser tool | ⬜ Planned |
| **v0.6.0** | MCP protocol adapter (v2.6.0) | ⬜ Planned |
| **v1.0.0** | npm + ClawHub publish | ⬜ Planned |

---

## 11. File Index — Quick Reference

| File | Purpose | Key Exports | v0.3.1 Changes |
|---|---|---|---|
| `src/index.ts` | Plugin entry point | `default` (OpenClawPluginDefinition) | None |
| `src/config.ts` | Configuration schema | `configSchema()` | Fixed mode enum + cloud fields |
| `src/types/memchain.ts` | MPI type definitions | All request/response interfaces | Added RecallRequest.query/mode, StatusResponse v2.5.0 fields |
| `src/core/client.ts` | HTTP client (3 modes) | `MemChainClient` class | None |
| `src/core/session-store.ts` | Session state | `SessionStore` class | Overflow warning + markOverflowWarned() |
| `src/core/formatter.ts` | Prompt formatter | `formatMemoriesForPrompt()` | None |
| `src/hooks/recall-hook.ts` | Core recall logic | `registerRecallHook()` | Log levels, query field, catch logging |
| `src/hooks/log-hook.ts` | Turn logging | `registerLogHook()` | Split user/assistant hooks, removed mode gate |
| `src/hooks/health-hook.ts` | Health check | `registerHealthHook()` | None |
| `src/tools/remember-tool.ts` | Memory store tool | `registerRememberTool()` | None |
| `src/tools/forget-tool.ts` | Memory delete tool | `registerForgetTool()` | Fixed execute() signature |
| `src/tools/recall-tool.ts` | Memory search tool | `registerRecallTool()` | Added query field, fixed log level |
| `src/tools/search-tool.ts` | BM25 keyword search | `registerSearchTool()` | Fixed mark tag regex |
| `src/tools/replay-tool.ts` | Session replay | `registerReplayTool()` | Standard comment header added |
| `skills/memchain-memory/SKILL.md` | Agent skill | (Markdown) | Updated tool list + privacy tags |
| `hooks/memchain-lifecycle/HOOK.md` | Hook metadata | (Markdown) | None |

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
- Three modes (local/remote/cloud) — all mode logic stays in client.ts only

THINGS NOT TO CHANGE:
- recall-hook priority (100) — lower priority means other plugins may override memory
- formatter output format — LLMs are sensitive to prompt structure changes
- client.ts null-return pattern — changing to exceptions would break all callers
- SessionStore TTL (4h) and max turns (200) — these prevent memory leaks
- Mode filtering location — ONLY in client.ts, NOT duplicated in hooks

THINGS SAFE TO CHANGE:
- Configuration defaults in config.ts
- Log messages and debug metadata
- Formatter text (with testing — affects LLM behavior)
- Tool descriptions (affects when agent chooses to use them)

CRITICAL BUG PATTERN TO AVOID (v0.3.1 lessons):
- execute() in registerTool MUST be (_toolCallId, params) — two args.
  Omitting the first arg silently breaks the tool (no TypeScript error).
- Never read event.context.responseText in message:preprocessed.
  It fires before the LLM responds — responseText is always undefined there.
  Use message:response for assistant turn collection instead.
- Never add mode checks in log-hook. Mode filtering is client.ts's job.
  Duplicating it caused cloud turns to never be collected.

TESTING:
- npm test for unit tests
- Manual E2E: npm run build → install plugin → send messages → check /recall
- Check gateway logs — expect [info] not [warn] for normal operation
- Verify /sessions/:id/conversation has BOTH user and assistant turns

DEPENDENCIES ON MEMCHAIN RUST SIDE:
- /api/mpi/embed must exist (v2.1.0+)
- /api/mpi/status must include embed_ready field
- /api/mpi/recall must sort Identity memories first
- /api/mpi/log must accept recall_context field
- /api/mpi/search, /context/inject, /sessions/:id/conversation (v2.5.0+)
```
