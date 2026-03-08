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
| **OpenClaw** | `>= 2026.3.7` | Uses `before_prompt_build` hook with `prependSystemContext` and ContextEngine plugin slot |
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

The skill teaches your agent when and how to use `memchain_remember`, `memchain_recall`, and `memchain_forget` tools. Without it, automatic recall and logging still work, but the agent won't proactively store memories.

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

# Increase token budget for more memory context
openclaw config set plugins.entries.aeronyx-memchain.config.tokenBudget 3000

# Disable automatic recall (manual only via memchain_recall tool)
openclaw config set plugins.entries.aeronyx-memchain.config.enableAutoRecall false
```

### Configuration Reference

| Key | Type | Default | Description |
|---|---|---|---|
| `memchainUrl` | string | `http://127.0.0.1:8421` | MemChain MPI endpoint URL |
| `embeddingModel` | string | `minilm-l6-v2` | Embedding model identifier (must match MemChain server) |
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
  message:preprocessed ──→ [log-hook] collects turn
       │
       ▼
  before_prompt_build  ──→ [recall-hook]
       │                       │
       │                   POST /api/mpi/embed (user message → 384d vector)
       │                   POST /api/mpi/recall (vector → ranked memories)
       │                       │
       │                   prependSystemContext:
       │                   "[MemChain] What you know about this user:
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
       ├── Agent may call memchain_remember ──→ POST /api/mpi/remember
       │
       ▼
  Response sent to user
       │
       ▼
  session:end ──→ [log-hook]
                      │
                  POST /api/mpi/log (all turns + recall_context)
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

Recall ranking is not just vector similarity. MemChain uses a 9-dimensional feature vector:

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

The plugin registers three tools the agent can use during conversations:

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

Explicitly search memories. Used for "what do you know about me?" queries and pre-forget lookup.

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

---

## Graceful Degradation

This plugin is designed to never break your OpenClaw agent:

| Scenario | Behavior |
|---|---|
| MemChain not running | All hooks return empty, agent works without memory |
| MemChain starts after gateway | Next recall/log will work automatically |
| Embed endpoint down | Recall skipped for that turn, no crash |
| /recall times out | Agent responds without memory context |
| /log fails | Session data cleared, no memory leak |
| /remember fails | Agent tells user "will be captured via log" |

---

## Troubleshooting

### Plugin not showing in `openclaw plugins list`

```bash
# Verify installation
npm ls -g @aeronyx/openclaw-memchain

# Reinstall
openclaw plugins install @aeronyx/openclaw-memchain --force
```

### "🧠 MemChain: UNREACHABLE" in logs

```bash
# Check if AeroNyx server is running
curl http://127.0.0.1:8421/api/mpi/status

# Check configured URL
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

### Agent not using memchain_remember

Ensure the skill is installed:

```bash
openclaw skills list | grep memchain
openclaw skills install @aeronyx/openclaw-memchain/skills/memchain-memory
```

---

## Development

```bash
# Clone
git clone https://github.com/AeroNyx/openclaw-memchain.git
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
│   │   └── memchain.ts             # MPI type definitions (6 endpoints)
│   ├── core/
│   │   ├── client.ts               # MemChain HTTP client (zero dependencies)
│   │   ├── session-store.ts        # In-memory session state (TTL cleanup)
│   │   └── formatter.ts            # Recall results → system prompt text
│   ├── hooks/
│   │   ├── recall-hook.ts          # before_prompt_build → embed → recall → inject
│   │   ├── log-hook.ts             # message:preprocessed + session:end → /log
│   │   └── health-hook.ts          # First session → health check + status log
│   └── tools/
│       ├── remember-tool.ts        # memchain_remember — agent stores memories
│       ├── forget-tool.ts          # memchain_forget — user-requested deletion
│       └── recall-tool.ts          # memchain_recall — explicit memory search
├── skills/
│   └── memchain-memory/
│       └── SKILL.md                # Teaches agent when/how to use MemChain tools
└── hooks/
    └── memchain-lifecycle/
        └── HOOK.md                 # Hook metadata for OpenClaw discovery
```

---

## License

MIT — same as OpenClaw.

---

## Links

- [AeroNyx MemChain Architecture](./ARCHITECTURE.md)
- [AeroNyx Server](https://github.com/AeroNyx/aeronyx)
- [OpenClaw Plugin SDK](https://docs.openclaw.ai/tools/plugin)
- [MemChain MPI Protocol](https://github.com/AeroNyx/aeronyx/blob/main/docs/mpi.md)
