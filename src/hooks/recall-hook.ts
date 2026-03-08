/**
 * ============================================
 * File: src/hooks/recall-hook.ts
 * ============================================
 * Creation Reason: Core hook — intercepts every LLM prompt build,
 *   queries MemChain for relevant memories, injects into system prompt.
 *
 * ⚠️ CRITICAL FIX (v0.1.2):
 *   OpenClaw before_prompt_build actual parameter structure:
 *     arg0 (event): { prompt: string, messages: Message[] }
 *       - prompt = current user message text (with timestamp prefix)
 *       - messages = full session history (role/content pairs)
 *     arg1 (ctx): { agentId, sessionKey, sessionId, workspaceDir, messageProvider, trigger, channelId }
 *       - sessionKey for MemChain session_id
 *       - NO messages on ctx
 *
 *   Message content format:
 *     { role: "user", content: [{ type: "text", text: "..." }], timestamp: number }
 *     Content is an ARRAY of parts, not a plain string.
 *
 * Last Modified: v0.1.2 — Fixed: messages on event (arg0), not ctx (arg1);
 *   added prompt field extraction; handle content array format
 * ============================================
 */

import type { MemChainClient } from "../core/client.js";
import type { SessionStore } from "../core/session-store.js";
import type { MemChainPluginConfig } from "../types/memchain.js";
import { formatMemoriesForPrompt } from "../core/formatter.js";

interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * arg0: event object with prompt + messages
 */
interface PromptBuildEvent {
  /** Current user message text (may have timestamp prefix like "[Sun 2026-03-08 18:51 UTC] hello") */
  prompt: string;
  /** Full session message history */
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; thinking?: string }>;
    timestamp?: number;
  }>;
}

/**
 * arg1: context object with session metadata
 */
interface PromptBuildContext {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  workspaceDir: string;
  messageProvider: string;
  trigger: string;
  channelId: string;
}

interface PromptBuildResult {
  prependSystemContext?: string;
  appendSystemContext?: string;
  prependContext?: string;
}

interface PluginApi {
  on(
    event: string,
    handler: (event: any, ctx: any) => Promise<PromptBuildResult>,
    options?: { priority?: number },
  ): void;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Hook Registration
// ---------------------------------------------------------------------------

export function registerRecallHook(
  api: PluginApi,
  client: MemChainClient,
  sessions: SessionStore,
  cfg: MemChainPluginConfig,
  log: PluginLogger,
): void {
  api.on(
    "before_prompt_build",
    async (event: PromptBuildEvent, ctx: PromptBuildContext): Promise<PromptBuildResult> => {
      // Step 0: Guard
      if (!cfg.enableAutoRecall) {
        return {};
      }

      // Step 1: Extract current user message
      // Prefer event.prompt (direct, clean), fallback to last user message in event.messages
      const userMessage = extractUserMessage(event);
      if (!userMessage) {
        log.warn("[MemChain] no user message found, skipping recall");
        return {};
      }

      const sessionKey = ctx.sessionKey;
      log.warn("[MemChain] recall started", {
        sessionKey,
        messagePreview: userMessage.slice(0, 80),
      });

      try {
        // Step 2: Embed via MemChain local MiniLM
        const embedding = await client.embedSingle(userMessage);
        if (!embedding) {
          log.warn("[MemChain] embed returned null — /embed unreachable");
          return {};
        }
        log.warn("[MemChain] embed OK", { dim: embedding.length });

        // Step 3: Recall from MemChain
        const sessionId = sessions.getOrCreateSessionId(sessionKey);
        const result = await client.recall({
          embedding,
          embedding_model: cfg.embeddingModel,
          top_k: cfg.recallTopK,
          token_budget: cfg.tokenBudget,
          session_id: sessionId,
        });

        if (!result?.memories?.length) {
          log.warn("[MemChain] recall returned empty — no memories found");
          return {};
        }

        log.warn("[MemChain] recall OK", {
          memoryCount: result.memories.length,
          tokenEstimate: result.token_estimate,
          layers: summarizeLayers(result.memories),
          topMemory: result.memories[0]?.content?.slice(0, 60),
        });

        // Step 4: Store recall context for /log negative feedback correlation
        sessions.setRecallContext(sessionKey, result.memories);

        // Step 5: Format and inject into system prompt
        const memoryContext = formatMemoriesForPrompt(result.memories);
        log.warn("[MemChain] INJECTING into system prompt", {
          promptLength: memoryContext.length,
          preview: memoryContext.slice(0, 150),
        });

        return {
          prependSystemContext: memoryContext,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("[MemChain] recall hook error", { error: message, sessionKey });
        return {};
      }
    },
    { priority: 100 },
  );
}

// ---------------------------------------------------------------------------
// Message extraction
// ---------------------------------------------------------------------------

/**
 * Extract the current user message from the before_prompt_build event.
 *
 * Strategy:
 * 1. Use event.prompt if available (current turn's user message)
 *    - Strip timestamp prefix like "[Sun 2026-03-08 18:51 UTC] "
 * 2. Fallback: walk event.messages backwards for last user role
 *    - Content may be string or array of {type:"text", text:"..."}
 */
function extractUserMessage(event: PromptBuildEvent): string | null {
  // Strategy 1: event.prompt (current user message with possible timestamp prefix)
  if (event.prompt && typeof event.prompt === "string") {
    const cleaned = stripTimestampPrefix(event.prompt.trim());
    if (cleaned.length >= 3) {
      return cleaned;
    }
  }

  // Strategy 2: Walk messages backwards for last user message
  if (Array.isArray(event.messages)) {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i];
      if (msg.role !== "user") continue;

      const text = extractTextFromContent(msg.content);
      if (text && text.length >= 3) {
        return stripTimestampPrefix(text);
      }
    }
  }

  return null;
}

/**
 * Extract plain text from message content.
 * Content can be:
 *   - A plain string: "hello"
 *   - An array of parts: [{ type: "text", text: "hello" }, { type: "image", ... }]
 */
function extractTextFromContent(
  content: string | Array<{ type: string; text?: string; thinking?: string }>,
): string | null {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const textParts = content
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text!.trim())
      .filter((t) => t.length > 0);

    if (textParts.length) {
      return textParts.join(" ");
    }
  }

  return null;
}

/**
 * Strip OpenClaw's timestamp prefix from user messages.
 * Format: "[Sun 2026-03-08 18:51 UTC] actual message here"
 * Also handles: "[Wed 2026-03-04 17:24 UTC] hello"
 */
function stripTimestampPrefix(text: string): string {
  // Match: [Day YYYY-MM-DD HH:MM TZ]
  const timestampPattern = /^\[[\w]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/;
  return text.replace(timestampPattern, "").trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeLayers(memories: Array<{ layer: string }>): string {
  const counts: Record<string, number> = {};
  for (const m of memories) {
    counts[m.layer] = (counts[m.layer] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([layer, count]) => `${layer}:${count}`)
    .join(", ");
}
