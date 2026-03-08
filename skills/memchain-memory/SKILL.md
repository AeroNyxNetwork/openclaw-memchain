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

- **Logging**: After each conversation, the full dialogue is sent to MemChain's
  rule engine, which automatically extracts identities, preferences, allergies,
  and detects when the user corrects you.

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

1. Use `memchain_recall` to find the relevant memory
2. Show the user what you found: "I found this memory: '[content]'. Delete it?"
3. Wait for user confirmation
4. Call `memchain_forget` with the `record_id` from the recall result

**Never forget memories without explicit user request and confirmation.**

## Important Behavioral Rules

1. **Don't parrot memories**: If you know the user's name is Alice from
   [MemChain] context, just use it naturally. Don't say "I remember your
   name is Alice."

2. **Trust current over remembered**: If a memory says "User prefers Python"
   but the user just said "I switched to Rust", trust the current statement
   and use `memchain_remember` to update the knowledge.

3. **Don't over-remember**: Not every message needs to be stored. Only
   remember information that has long-term value. "What's the weather?"
   is not worth remembering. "I moved to Tokyo" is.

4. **Corrections are automatic**: When the user says "That's wrong" or
   "Actually, it's...", the /log rule engine detects this and penalizes
   the incorrect memory. You don't need to manually handle corrections.

5. **Dedup is automatic**: If you're unsure whether something is already
   remembered, just call `memchain_remember` — MemChain will detect
   duplicates and skip them (Identity: cosine > 0.92, Knowledge: > 0.88).
