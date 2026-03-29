# 🧠 @aeronyx/openclaw-memchain

**AeroNyx MemChain cognitive memory plugin for OpenClaw.**

Give your OpenClaw agent persistent, cross-session memory powered by a 4-layer cognitive model with adaptive scoring, negative feedback learning, and co-occurrence graph — all running locally on your machine.

---

## What This Does

When you install this plugin, your OpenClaw agent will:

1. **Remember users across conversations** — The agent knows your name, allergies, preferences, and current projects without being told again.
2. **Learn from corrections** — Say "that's wrong" and the system automatically penalizes the incorrect memory, improving recall accuracy over time.
3. **Respect your data sovereignty** — All memories are stored locally in MemChain's encrypted SQLite database. Nothing leaves your machine unless you configure P2P sync.

### Before & After

| Without MemChain | With MemChain |
|---|---|
| "What's your name?" every session | Agent knows you're Alice from day one |
| Recommends shellfish to someone with allergies | Identity-layer allergy memory blocks bad suggestions |
| Forgets project context between sessions | Episode memories carry context forward |
| No way to correct wrong memories | "That's wrong" triggers automatic feedback penalty |
| Memory is a flat text blob | 4-layer cognitive model (Identity → Knowledge → Episode → Archive) |

---

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| **OpenClaw** | `>= 2026.3.7` | Uses `before_prompt_build`, `message:preprocessed`, `message:response` hooks |
| **AeroNyx Server** | `>= 2.1.0+Embed` | Provides MemChain MPI endpoints + local MiniLM embedding engine |
| **Node.js** | `>= 22` | Matches OpenClaw's runtime requirement; uses built-in `fetch` |

---

## Installation

### Step 1: Ensure AeroNyx MemChain is Running

```bash
# Check MemChain health
curl -s http://127.0.0.1:8421/api/mpi/status | jq .

# Expected: memchain_enabled=true, index_ready=true, embed_ready=true
```

If MemChain isn't running, follow the [AeroNyx installation guide](https://github.com/AeroNyx/aeronyx).

### Step 2: Install the Plugin

```bash
openclaw plugins install @aeronyx/openclaw-memchain
```

### Step 3: Install the Skill (Optional but Recommended)

```bash
openclaw skills install @aeronyx/openclaw-memchain/skills/memchain-memory
```

The skill teaches your agent when and how to use the MemChain tools. Without it, automatic recall and logging still work, but the agent won't proactively store memories.

### Step 4: Restart Gateway

```bash
openclaw gateway restart
```

### Step 5: Verify

```bash
# Plugin should be listed and enabled
openclaw plugins list

# Hooks should be registered
openclaw hooks list

# Check gateway logs for health check
# Look for: "🧠 MemChain: CONNECTED — ✅ Engine enabled | ✅ Index ready | ✅ Embed ready (384d)"
```

---

## Configuration

All settings have sensible defaults for local deployment. Override via CLI:

```bash
# Change MemChain URL (if running on different host/port)
openclaw config set plugins.entries.aeronyx-memchain.config.memchainUrl "http://192.168.1.100:8421"

# Use remote mode (Ed25519 + E2E encryption)
openclaw config set plugins.entries.aeronyx-memchain.config.mode "remote"
openclaw config set plugins.entries.aeronyx-memchain.config.nodeUrl "http://node-ip:8421"

# Use cloud mode (CMS relay)
openclaw config set plugins.entries.aeronyx-memchain.config.mode "cloud"
openclaw config set plugins.entries.aeronyx-memchain.config.cmsUrl "https://api.aeronyx.network"
openclaw config set plugins.entries.aeronyx-memchain.config.apiKey "sk-xxx"

# Increase token budget for more memory context
openclaw config set plugins.entries.aeronyx-memchain.config.tokenBudget 3000

# Disable automatic recall (manual only via memchain_recall tool)
openclaw config set plugins.entries.aeronyx-memchain.config.enableAutoRecall false
```

### Configuration Reference

| Key | Type | Default | Description |
|---|---|---|---|
| `mode` | string | `local` | Operating mode: `local`, `remote`, or `cloud` |
| `memchainUrl` | string | `http://127.0.0.1:8421` | MemChain MPI endpoint URL (local mode) |
| `nodeUrl` | string | `""` | Remote node URL (remote mode only) |
| `cmsUrl` | string | `https://api.aeronyx.network` | CMS relay URL (cloud mode only) |
| `apiKey` | string | `""` | Bearer token sk-xxx (cloud mode only) |
| `keyStorePath` | string | `~/.openclaw/memchain-keys.json` | Ed25519 key file (remote/cloud) |
| `embeddingModel` | string | `minilm-l6-v2` | Embedding model (must match MemChain server) |
| `sourceAi` | string | `openclaw-memchain` | Source identifier for remember/log calls |
| `tokenBudget` | number | `2000` | Max tokens for recall context in system prompt (100-8000) |
| `recallTopK` | number | `10` | Max memories per recall (1-50) |
| `timeout` | number | `5000` | HTTP timeout in ms (1000-30000) |
| `enableAutoRecall` | boolean | `true` | Auto-recall on every message |
| `enableAutoLog` | boolean | `true` | Auto-log turns on session end |

---

## How It Works

### Data Flow

```
User sends message (WhatsApp / Telegram / Slack / ...)
       │
       ▼
  message:preprocessed ──→ [log-hook] collects USER turn
       │
       ▼
  before_prompt_build  ──→ [recall-hook]
       │                       │
       │                   GET /api/mpi/context/inject (v2.5.0+, optional)
       │                       → project context + session summaries + entities
       │                   POST /api/mpi/embed (user message → 384d vector)
       │                   POST /api/mpi/recall (vector + query → ranked memories)
       │                       │
       │                   prependSystemContext:
       │                   "## Project: Alpha
       │                    ...
       │                    [MemChain] What you know about this user:
       │                    Core identity:
       │                    - User name is Alice
       │                    Preferences & knowledge:
       │                    - Prefers dark mode
       │                    Recent context:
       │                    - Working on MemChain integration [2h ago]"
       │
       ▼
  LLM generates response (with memory context)
       │
       ├── Agent may call memchain_remember  ──→ POST /api/mpi/remember
       ├── Agent may call memchain_search    ──→ GET  /api/mpi/search
       ├── Agent may call memchain_replay    ──→ GET  /api/mpi/sessions/:id/conversation
       │
       ▼
  Response sent to user
       │
       ▼
  message:response ──→ [log-hook] collects ASSISTANT turn
       │
       ▼
  session:end ──→ [log-hook]
                      │
                  POST /api/mpi/log (user + assistant turns + recall_context)
                      │
                  Rule engine auto-extracts:
                  • P2: "I am..." → identity
                  • P4: "be casual..." → preference
                  • P5: "allergic to..." → allergy
                  • Negative feedback: "wrong" → penalize recalled memory
```

### Memory Layers

MemChain uses a 4-layer cognitive model based on Tulving's dual-memory theory:

| Layer | Decay Rate | Dedup Threshold | Use Case |
|---|---|---|---|
| **Identity** | Never (8760h stability) | cos > 0.92 | Name, allergies, family, job |
| **Knowledge** | Slow (2160h stability) | cos > 0.88 | Preferences, skills, tools |
| **Episode** | Fast (168h stability) | cos > 0.80 + 24h window | Current projects, today's plans |
| **Archive** | Very slow (720h stability) | No dedup | Compressed old memories |

Identity memories always appear first in recall results, regardless of embedding similarity.

### Cognitive Scoring (MVF)

Recall ranking uses a 9-dimensional feature vector:

```
φ₀ = cos(embed(memory), embed(query))     semantic similarity
φ₁ = exp(-Δt / stability)                  time decay (forgetting curve)
φ₂ = min(1 + 0.3×ln(access+1), 3.5)       frequency boost (more used = higher)
φ₃ = L(layer)                              layer privilege (identity > knowledge > episode)
φ₄ = (pos - neg) / (pos + neg + 1)         feedback score (corrections lower this)
φ₅ = degree(m) / max_degree                co-occurrence graph centrality
φ₆ = 𝟙(timestamp ∈ time_hint)              time match
φ₇ = cos(embed(m), session_centroid)        session topic coherence
φ₈ = -𝟙(has_conflict)                      conflict penalty
```

---

## Agent Tools

The plugin registers 5 tools the agent can use during conversations:

### `memchain_remember`

Proactively store user information. The agent decides layer and tags.

```
Agent calls: memchain_remember({
  content: "User is allergic to peanuts",
  layer: "identity",
  topic_tags: ["health", "allergy"]
})
→ "Remembered [identity]: User is allergic to peanuts"
```

### `memchain_recall`

Explicitly search memories by semantic similarity.

```
Agent calls: memchain_recall({ query: "user health conditions" })
→ "Found 2 memories (from 8 candidates):
   1. [identity] User is allergic to peanuts
      ID: 557014a3  Score: 1.30  Tags: health, allergy
   2. [episode] User had a headache yesterday
      ID: da762b97  Score: 0.65  Tags: health"
```

### `memchain_forget`

Delete a memory permanently. Requires user confirmation.

```
Agent calls: memchain_forget({ record_id: "557014a3..." })
→ "Memory 557014a3... has been permanently deleted."
```

### `memchain_search`

BM25 keyword search across all memories. Better for exact terms.

```
Agent calls: memchain_search({ query: "JWT authentication" })
→ "Found 3 results for "JWT authentication":
   **Session: MemChain integration**
   - User implemented **JWT** auth with RS256 (score: 4.2)
   ..."
```

### `memchain_replay`

Replay a previous conversation session.

```
Agent calls: memchain_replay({ session_id: "oc-18f3a2b1-4c7d8e9f" })
→ "**Session**: MemChain integration
   **Summary**: Discussed JWT auth and plugin setup
   **Turns**: 12
   👤 User: How do I set up Ed25519 signing?
   🤖 Assistant: Here's how to generate keys..."
```

---

## Graceful Degradation

This plugin is designed to never break your OpenClaw agent:

| Scenario | Behavior |
|---|---|
| MemChain not running | All hooks return empty, agent works without memory |
| MemChain starts after gateway | Next recall/log will work automatically |
| context/inject unavailable (older server) | Skipped silently, recall still works |
| Embed endpoint down | Recall skipped for that turn, no crash |
| /recall times out | Agent responds without memory context |
| /log fails (local) | Session data cleared, no memory leak |
| /log skipped (remote/cloud) | Expected — use memchain_remember tool |
| /remember fails | Agent tells user "will be captured via log" |
| Session exceeds 200 turns | Oldest turns dropped with one-time warning |

---

## Troubleshooting

### Plugin not showing in `openclaw plugins list`

```bash
npm ls -g @aeronyx/openclaw-memchain
openclaw plugins install @aeronyx/openclaw-memchain --force
```

### "🧠 MemChain: UNREACHABLE" in logs

```bash
curl http://127.0.0.1:8421/api/mpi/status
openclaw config get plugins.entries.aeronyx-memchain.config.memchainUrl
```

### Memories not being recalled

```bash
# Verify embed is working
curl -X POST http://127.0.0.1:8421/api/mpi/embed \
  -H 'Content-Type: application/json' \
  -d '{"texts":["test"]}'

# Check if memories exist
curl -X POST http://127.0.0.1:8421/api/mpi/recall \
  -H 'Content-Type: application/json' \
  -d '{"top_k":10}'
```

### /log not capturing both sides of conversation

```bash
# Check that BOTH user and assistant turns are logged (v0.3.1+)
curl -s "http://127.0.0.1:8421/api/mpi/sessions/<session_id>/conversation" \
  | jq '.turns[] | .role'
# Expected: "user" and "assistant" entries

# Verify message:response hook is firing in gateway logs
tail -f /tmp/openclaw-999/openclaw-$(date +%Y-%m-%d).log \
  | grep "Turn collected"
# Expected: both (user) and (assistant) log lines
```

### memchain_forget always returns "No record_id provided"

This was a bug in versions before v0.3.1. Update to v0.3.1 or later.

### Agent not using memchain_remember

```bash
openclaw skills list | grep memchain
openclaw skills install @aeronyx/openclaw-memchain/skills/memchain-memory
```

---

## Development

```bash
# Clone
git clone https://github.com/AeroNyxNetwork/openclaw-memchain.git
cd openclaw-memchain

# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev

# Run tests
npm test
```

### Project Structure

```
aeronyx-openclaw-memchain/
├── package.json                    # npm package + OpenClaw hook declarations
├── tsconfig.json                   # TypeScript config (ES2022, Node16 modules)
├── src/
│   ├── index.ts                    # Plugin entry — wires hooks + tools
│   ├── config.ts                   # JSON Schema for plugin configuration
│   ├── types/
│   │   └── memchain.ts             # MPI type definitions (all endpoints)
│   ├── core/
│   │   ├── client.ts               # MemChain HTTP client (3 modes, zero deps)
│   │   ├── session-store.ts        # In-memory session state (TTL cleanup)
│   │   └── formatter.ts            # Recall results → system prompt text
│   ├── hooks/
│   │   ├── recall-hook.ts          # before_prompt_build → context/inject → embed → recall → inject
│   │   ├── log-hook.ts             # preprocessed(user) + response(assistant) + end → /log
│   │   └── health-hook.ts          # session:start → health check + NER/graph status
│   └── tools/
│       ├── remember-tool.ts        # memchain_remember — agent stores memories
│       ├── forget-tool.ts          # memchain_forget — user-requested deletion
│       ├── recall-tool.ts          # memchain_recall — semantic memory search
│       ├── search-tool.ts          # memchain_search — BM25 keyword search
│       └── replay-tool.ts          # memchain_replay — conversation replay
├── skills/
│   └── memchain-memory/
│       └── SKILL.md                # Teaches agent when/how to use MemChain tools
└── hooks/
    └── memchain-lifecycle/
        └── HOOK.md                 # Hook metadata for OpenClaw discovery
```

---

## Changelog

### v0.3.1 (2026-03-29) — Code Review & Bug Fixes
- **Fixed**: `memchain_forget` always returned "No record_id provided" — `execute()` was missing its first `_toolCallId` argument
- **Fixed**: `/log` only captured user turns — assistant turns require `message:response` hook, not `message:preprocessed`
- **Fixed**: Cloud mode turns were never collected — removed duplicate mode gate in log-hook
- **Fixed**: `client.recall()` missing `query` field — server-side hybrid retrieval was degraded
- **Fixed**: `config.ts` mode enum missing `"cloud"` — cloud config silently fell back to local
- **Fixed**: `search-tool.ts` `<mark>` replacement produced broken Markdown bold markers
- **Fixed**: All normal operational logs were at `warn` level — now correctly `debug`/`info`
- **Fixed**: `getContextInjection` catch block was completely silent — now logs at `debug`
- **Added**: `session-store.ts` overflow warning (one-time per session, not silent)
- **Added**: `types/memchain.ts` v2.5.0 status fields + `RecallRequest.query/mode`

### v0.3.0 (2026-03-11)
- Cloud mode: CMS relay + Ed25519 + E2E encryption
- New tools: `memchain_search` (BM25) + `memchain_replay` (conversation replay)
- `/context/inject` integration in recall-hook
- v2.5.0 NER/graph/SuperNode status display in health-hook

### v0.2.0 (2026-03-10)
- Remote mode: Ed25519 request signing + ChaCha20-Poly1305 E2E encryption
- Key management: auto-generate Ed25519 key pair on first startup

### v0.1.3 (2026-03-10)
- Full pipeline validation: recall + remember tool + /log rule engine
- Fixed: `registerTool` API — `names` (plural) + `execute(_toolCallId, params)`

### v0.1.0 (2026-03-08)
- Initial release: recall-hook + log-hook + health-hook + 3 tools

---

## License

MIT — same as OpenClaw.

---

## Links

- [Architecture Deep Dive](./ARCHITECTURE.md)
- [AeroNyx Server](https://github.com/AeroNyx/aeronyx)
- [OpenClaw Plugin SDK](https://docs.openclaw.ai/tools/plugin)
- [MemChain MPI Protocol](https://github.com/AeroNyx/aeronyx/blob/main/docs/mpi.md)
