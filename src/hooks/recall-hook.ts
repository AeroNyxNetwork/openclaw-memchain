/**
 * ============================================
 * File: src/hooks/recall-hook.ts
 * ============================================
 * Creation Reason: Core hook — intercepts every LLM prompt build,
 *   queries MemChain for relevant memories, injects into system prompt.
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient)
 *   - src/core/session-store.ts (SessionStore)
 *   - src/core/formatter.ts (formatMemoriesForPrompt)
 *   - src/types/memchain.ts (MemChainPluginConfig)
 *
 * ⚠️ Important Note for Next Developer:
 *   - This hook MUST be fault-tolerant: any failure → return {} (no injection)
 *   - Never throw from the hook handler
 *   - Priority 100 ensures memories are injected before other plugins
 *   - After verification, change log.warn back to log.debug for production
 *
 * Last Modified: v0.1.1 — warn-level logging at each step for deployment verification
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
interface PluginApi {
  on(
    event: string,
    handler: (event: unknown, ctx: PromptBuildContext) => Promise<PromptBuildResult>,
    options?: { priority?: number },
  ): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface PromptBuildContext {
  sessionKey: string;
  messages: Array<{ role: string; content: string | unknown }>;
}

interface PromptBuildResult {
  prependSystemContext?: string;
  appendSystemContext?: string;
  prependContext?: string;
}

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
    async (_event: unknown, ctx: PromptBuildContext): Promise<PromptBuildResult> => {
      // Step 0: Guard
      if (!cfg.enableAutoRecall) {
        log.warn("[MemChain] recall disabled by config");
        return {};
      }

      // Step 1: Extract user message
      const userMessage = extractLastUserMessage(ctx.messages);
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
        // Step 2: Embed
        const embedding = await client.embedSingle(userMessage);
        if (!embedding) {
          log.warn("[MemChain] embed returned null — MemChain /embed unreachable");
          return {};
        }
        log.warn("[MemChain] embed OK", { dim: embedding.length });

        // Step 3: Recall
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

        // Step 4: Store recall context for /log
        sessions.setRecallContext(sessionKey, result.memories);

        // Step 5: Format and inject
        const memoryContext = formatMemoriesForPrompt(result.memories);
        log.warn("[MemChain] injecting into system prompt", {
          promptLength: memoryContext.length,
          promptPreview: memoryContext.slice(0, 120),
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
// Helpers
// ---------------------------------------------------------------------------

function extractLastUserMessage(
  messages: Array<{ role: string; content: string | unknown }>,
): string | null {
  if (!messages?.length) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    if (typeof msg.content === "string") {
      const trimmed = msg.content.trim();
      if (trimmed.length >= 3) return trimmed;
      continue;
    }

    if (Array.isArray(msg.content)) {
      const textParts = (msg.content as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text!.trim())
        .filter((text) => text.length >= 3);
      if (textParts.length) return textParts.join(" ");
    }
  }

  return null;
}

function summarizeLayers(memories: Array<{ layer: string }>): string {
  const counts: Record<string, number> = {};
  for (const m of memories) {
    counts[m.layer] = (counts[m.layer] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([layer, count]) => `${layer}:${count}`)
    .join(", ");
}
