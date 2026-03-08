/**
 * ============================================
 * File: src/core/formatter.ts
 * ============================================
 * Creation Reason: Transform MemChain recall results into a human-readable
 *   text block suitable for injection into the LLM's system prompt.
 *
 * Main Functionality:
 *   - Group memories by cognitive layer (identity → knowledge → episode)
 *   - Format each memory with content, tags, and age indicator
 *   - Add behavioral instructions for the LLM
 *
 * Dependencies:
 *   - src/types/memchain.ts (Memory interface)
 *   - Referenced by: hooks/recall-hook.ts
 *
 * ⚠️ Important Note for Next Developer:
 *   - The output format directly affects LLM behavior — test changes carefully
 *   - Identity memories MUST always appear first
 *   - The "[MemChain]" prefix helps the LLM distinguish memory from other context
 *
 * Last Modified: v0.1.0-fix1 — Fixed: added export keyword to function
 * ============================================
 */

import type { Memory } from "../types/memchain.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (!memories.length) return "";

  const identity: Memory[] = [];
  const knowledge: Memory[] = [];
  const episodes: Memory[] = [];

  for (const m of memories) {
    switch (m.layer) {
      case "identity":
        identity.push(m);
        break;
      case "knowledge":
        knowledge.push(m);
        break;
      case "episode":
      case "archive":
        episodes.push(m);
        break;
    }
  }

  const lines: string[] = [];
  lines.push("[MemChain] What you know about this user:");

  if (identity.length) {
    lines.push("");
    lines.push("Core identity:");
    for (const m of identity) {
      lines.push(formatMemoryLine(m, false));
    }
  }

  if (knowledge.length) {
    lines.push("");
    lines.push("Preferences & knowledge:");
    for (const m of knowledge) {
      lines.push(formatMemoryLine(m, false));
    }
  }

  if (episodes.length) {
    lines.push("");
    lines.push("Recent context:");
    for (const m of episodes) {
      lines.push(formatMemoryLine(m, true));
    }
  }

  lines.push("");
  lines.push("Use this context naturally. Do not repeat it back verbatim.");
  lines.push("If any memory seems wrong, trust the user's current statement instead.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Formatting helpers (internal)
// ---------------------------------------------------------------------------

function formatMemoryLine(memory: Memory, showAge: boolean): string {
  let line = `- ${memory.content}`;

  if (memory.topic_tags?.length && memory.layer !== "identity") {
    line += ` (${memory.topic_tags.join(", ")})`;
  }

  if (showAge && memory.timestamp) {
    line += ` [${formatRelativeAge(memory.timestamp)}]`;
  }

  return line;
}

function formatRelativeAge(unixSeconds: number): string {
  const nowSeconds = Date.now() / 1000;
  const diffSeconds = Math.max(0, nowSeconds - unixSeconds);

  if (diffSeconds < 60) {
    return "just now";
  }
  if (diffSeconds < 3600) {
    return `${Math.round(diffSeconds / 60)}m ago`;
  }
  if (diffSeconds < 86400) {
    return `${Math.round(diffSeconds / 3600)}h ago`;
  }
  if (diffSeconds < 604800) {
    return `${Math.round(diffSeconds / 86400)}d ago`;
  }
  return `${Math.round(diffSeconds / 604800)}w ago`;
}
