---
name: memchain-memory
description: "Cognitive memory management via AeroNyx MemChain — 4-layer memory with automatic recall, learning from feedback, and user-controlled forgetting"
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      plugins: ["aeronyx-memchain"]
---

# MemChain Memory Management

You have access to a cognitive memory system (MemChain) that remembers
information about users across conversations. It is more sophisticated than
simple note-taking — it uses a 4-layer cognitive model, learns from your
corrections, and automatically extracts information from conversations.

## What Happens Automatically (No Action Needed)

- **Recall**: Before each of your responses, relevant memories about the user
  are injected into your context. You will see a `[MemChain]` block with
  identity, preferences, and recent context. Use this naturally.

- **Project Context**: When available, a `## Project` block appears above the
  memory block, showing recent session summaries and key entities. Use this
  to stay oriented within an ongoing project.

- **Logging**: After each conversation, both your messages and the user's
  messages are sent to MemChain's rule engine, which automatically extracts
  identities, preferences, allergies, and detects when the user corrects you.

## When to Use `memchain_remember`

Call this tool when the user shares information worth remembering long-term:

### Layer: `identity` — Who the user IS (never decays)
- Name, age, birthday
- Job title, employer, profession
- Allergies, medical conditions
- Family members, pets
- Location, nationality

### Layer: `knowledge` — What the user PREFERS (slow decay)
- Programming languages, frameworks, tools
- Communication style preferences
- Dietary preferences, hobbies
- Workflow and productivity habits
- Learning style

### Layer: `episode` — What is HAPPENING (fast decay)
- Current project or task
- Today's schedule or plans
- Temporary situations ("traveling this week")
- Recent decisions or events

### Content Format Rules
1. **Always third person**: Write "User is allergic to peanuts", NOT "I am allergic to peanuts"
2. **Summarize, don't quote**: Write "User prefers concise responses", NOT "User said 'keep it short'"
3. **One fact per call**: Don't combine multiple facts into one memory
4. **Be specific**: Write "User uses Rust and TypeScript for backend", NOT "User is a programmer"

### Examples

```
User: "I'm a senior Rust developer at AeroNyx"
→ memchain_remember({
    content: "User is a senior Rust developer at AeroNyx",
    layer: "identity",
    topic_tags: ["job", "programming", "rust"]
  })

User: "I prefer dark mode and minimal UI"
→ memchain_remember({
    content: "User prefers dark mode and minimal user interfaces",
    layer: "knowledge",
    topic_tags: ["preference", "ui"]
  })

User: "I'm working on the MemChain integration this week"
→ memchain_remember({
    content: "User is working on MemChain integration",
    layer: "episode",
    topic_tags: ["work", "project", "memchain"]
  })
```

## When to Use `memchain_search`

Call this when the user asks to find something specific by keywords:

- "Find where we discussed JWT"
- "Search for Redis errors"
- "When did I mention Alice?"

The query should be keywords, not full sentences:
```
memchain_search({ query: "JWT authentication" })
memchain_search({ query: "Redis connection timeout" })
```

Results are grouped by session with highlighted snippets.
Use this instead of `memchain_recall` when the user knows exactly what
term they're looking for (keyword match > semantic similarity).

## When to Use `memchain_replay`

Call this when the user wants to review a previous conversation:

- "What did we discuss in our last session?"
- "Show me the conversation about the API redesign"
- "Replay session alpha_001"

Workflow:
1. Use `memchain_search` to find the relevant session_id
2. Call `memchain_replay` with that session_id
3. Present the key points from the conversation

```
memchain_replay({ session_id: "oc-18f3a2b1-4c7d8e9f" })
memchain_replay({ session_id: "oc-18f3a2b1-4c7d8e9f", max_turns: 10 })
```

## When to Use `memchain_recall`

Call this when:
- User asks "What do you know about me?" or "What do you remember?"
- You need to find a specific memory before calling `memchain_forget`
- You want to search for memories on a specific topic

The query should describe what you're looking for:
```
memchain_recall({ query: "user allergies and health conditions" })
memchain_recall({ query: "programming preferences" })
```

## When to Use `memchain_forget`

**Only when the user explicitly asks to forget something.** Always follow this workflow:

1. Use `memchain_recall` to find the relevant memory and get its `record_id`
2. Show the user what you found: "I found this memory: '[content]'. Delete it?"
3. Wait for explicit user confirmation
4. Call `memchain_forget` with the `record_id` from the recall result

**Never forget memories without explicit user request and confirmation.**

```
memchain_forget({ record_id: "557014a3..." })
```

## Important Behavioral Rules

1. **Don't parrot memories**: If you know the user's name is Alice from
   the `[MemChain]` context, just use it naturally. Don't say "I remember
   your name is Alice."

2. **Trust current over remembered**: If a memory says "User prefers Python"
   but the user just said "I switched to Rust", trust the current statement
   and use `memchain_remember` to update the knowledge layer.

3. **Don't over-remember**: Not every message needs to be stored. Only
   remember information with long-term value. "What's the weather?" is
   not worth remembering. "I moved to Tokyo" is.

4. **Corrections are automatic**: When the user says "That's wrong" or
   "Actually, it's...", the /log rule engine detects this and penalizes
   the incorrect memory automatically. You don't need to handle this manually.

5. **Dedup is automatic**: If you're unsure whether something is already
   remembered, just call `memchain_remember` — MemChain detects duplicates
   and skips them (Identity: cosine > 0.92, Knowledge: > 0.88).

6. **Use search for keywords, recall for concepts**: When the user asks
   about a specific term ("find JWT"), use `memchain_search`. When they
   ask about a concept ("what do you know about my auth setup"), use
   `memchain_recall`.

## Privacy Controls

Users can use privacy tags in their messages to control what gets stored:

- `<no-mem>sensitive info</no-mem>` — Content inside will NOT be stored in MemChain
- `<private>private note</private>` — Content stored but excluded from recall results

Example: "My API key is <no-mem>sk-abc123</no-mem>, please help me configure it."

When you see these tags, respect them — do NOT include the tagged content in
your `memchain_remember` calls. The /log rule engine handles tag stripping
automatically, but if you're manually remembering, strip them yourself.

## Tool Summary

| Tool | When to Use | Input |
|---|---|---|
| `memchain_remember` | User shares long-term info | content, layer, topic_tags |
| `memchain_recall` | Find memories by concept | query, top_k |
| `memchain_forget` | User explicitly requests deletion | record_id |
| `memchain_search` | Find memories by exact keyword | query, limit |
| `memchain_replay` | Review a past conversation | session_id, max_turns |
