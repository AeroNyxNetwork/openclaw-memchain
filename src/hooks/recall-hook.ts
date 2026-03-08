/**
 * ============================================
 * File: src/hooks/recall-hook.ts
 * ============================================
 * Creation Reason: Core hook — intercepts every LLM prompt build,
 *   queries MemChain for relevant memories, injects into system prompt.
 *
 * Main Functionality:
 *   - Hook into OpenClaw's "before_prompt_build" lifecycle event
 *   - Extract latest user message from session
 *   - Call MemChain /api/mpi/embed → /api/mpi/recall
 *   - Format results and inject via prependSystemContext
 *   - Store recall_context in SessionStore for /log correlation
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
 *
 * Last Modified: v0.1.0-fix1 — Fixed: correct import paths with export names
 * ============================================
 */

import type { MemChainClient } from "../core/client.js";
import type { SessionStore } from "../core/session-store.js";
import type { MemChainPluginConfig } from "../types/memchain.js";
import { formatMemoriesForPrompt } from "../core/formatter.js";

/** Minimal logger interface */
interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

interface PluginApi {
  on(
    event: string,
    handler: (event: unknown, ctx: PromptBuildContext) => Promise<PromptBuildResult>,
    options?: { priority?: number },
  ): void;
}

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
      if (!cfg.enableAutoRecall) {
        return {};
      }

      const userMessage = extractLastUserMessage(ctx.messages);
      if (!userMessage) {
        log.debug("No user message found, skipping recall");
        return {};
      }

      const sessionKey = ctx.sessionKey;

      try {
        const embedding = await client.embedSingle(userMessage);
        if (!embedding) {
          log.debug("Embed unavailable, skipping recall");
          return {};
        }

        const sessionId = sessions.getOrCreateSessionId(sessionKey);
        const result = await client.recall({
          embedding,
          embedding_model: cfg.embeddingModel,
          top_k: cfg.recallTopK,
          token_budget: cfg.tokenBudget,
          session_id: sessionId,
        });

        if (!result?.memories?.length) {
          log.debug("No memories recalled", { sessionKey });
          return {};
        }

        sessions.setRecallContext(sessionKey, result.memories);

        const memoryContext = formatMemoriesForPrompt(result.memories);

        log.debug("Recall injected", {
          sessionKey,
          memoryCount: result.memories.length,
          tokenEstimate: result.token_estimate,
          layers: summarizeLayers(result.memories),
        });

        return {
          prependSystemContext: memoryContext,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Recall hook failed, continuing without memory", {
          error: message,
          sessionKey,
        });
        return {};
      }
    },
    { priority: 100 },
  );
}

// ---------------------------------------------------------------------------
// Helper functions
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
      if (trimmed.length >= 3) {
        return trimmed;
      }
      continue;
    }

    if (Array.isArray(msg.content)) {
      const textParts = (msg.content as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === "text" && part.text)
        .map((part) => part.text!.trim())
        .filter((text) => text.length >= 3);

      if (textParts.length) {
        return textParts.join(" ");
      }
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
