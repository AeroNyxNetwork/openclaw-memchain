/**
 * ============================================
 * File: src/hooks/recall-hook.ts
 * ============================================
 * Creation Reason: This is the CORE hook of the entire plugin.
 *   It intercepts every LLM prompt build, queries MemChain for relevant
 *   memories, and injects them into the system prompt so the AI "remembers"
 *   the user across conversations.
 *
 * Main Functionality:
 *   - Hook into OpenClaw's "before_prompt_build" lifecycle event
 *   - Extract the latest user message from the session
 *   - Call MemChain /api/mpi/embed to vectorize the message
 *   - Call MemChain /api/mpi/recall with the embedding
 *   - Format results and inject via prependSystemContext
 *   - Store recall_context in SessionStore for later /log correlation
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient.embed, .recall)
 *   - src/core/session-store.ts (SessionStore)
 *   - src/core/formatter.ts (formatMemoriesForPrompt)
 *   - src/types/memchain.ts (MemChainPluginConfig)
 *   - OpenClaw Plugin SDK: api.on("before_prompt_build", ...)
 *
 * Main Logical Flow:
 *   1. before_prompt_build fires (after session load, messages available)
 *   2. Extract last user message from ctx.messages
 *   3. POST /api/mpi/embed → get 384-dim embedding
 *   4. POST /api/mpi/recall → get ranked memories
 *   5. Store recall_context in SessionStore (for log-hook)
 *   6. Format memories → return { prependSystemContext: "..." }
 *   7. OpenClaw prepends this to system prompt before LLM call
 *
 * ⚠️ Important Note for Next Developer:
 *   - This hook MUST be fault-tolerant: any failure → return {} (no injection)
 *   - Never throw from the hook handler — it would break the LLM call chain
 *   - Priority 100 ensures memories are injected before other plugins
 *   - The embed → recall round-trip should be < 30ms on localhost
 *   - If enableAutoRecall is false, this hook does nothing
 *
 * Last Modified: v0.1.0 - Initial creation
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

/**
 * Minimal type for the OpenClaw Plugin API.
 * We only use api.on() for typed lifecycle hooks.
 */
interface PluginApi {
  on(
    event: string,
    handler: (event: unknown, ctx: PromptBuildContext) => Promise<PromptBuildResult>,
    options?: { priority?: number },
  ): void;
}

/** Context provided by OpenClaw's before_prompt_build event */
interface PromptBuildContext {
  sessionKey: string;
  messages: Array<{ role: string; content: string | unknown }>;
}

/** Result returned to OpenClaw — fields are optional and merged */
interface PromptBuildResult {
  prependSystemContext?: string;
  appendSystemContext?: string;
  prependContext?: string;
}

// ---------------------------------------------------------------------------
// Hook Registration
// ---------------------------------------------------------------------------

/**
 * Register the recall hook on OpenClaw's before_prompt_build event.
 *
 * This is the main entry point called from src/index.ts during plugin
 * registration. It captures the client, session store, config, and logger
 * in a closure so the async handler has access to them on every invocation.
 *
 * @param api      - OpenClaw Plugin API
 * @param client   - MemChain HTTP client
 * @param sessions - In-memory session state store
 * @param cfg      - Plugin configuration (tokenBudget, recallTopK, etc.)
 * @param log      - Plugin logger
 */
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
      // ---------------------------------------------------------------
      // Guard: auto-recall disabled by config
      // ---------------------------------------------------------------
      if (!cfg.enableAutoRecall) {
        return {};
      }

      // ---------------------------------------------------------------
      // Step 1: Extract the most recent user message
      // ---------------------------------------------------------------
      const userMessage = extractLastUserMessage(ctx.messages);
      if (!userMessage) {
        log.debug("No user message found, skipping recall");
        return {};
      }

      const sessionKey = ctx.sessionKey;

      try {
        // -------------------------------------------------------------
        // Step 2: Generate embedding via MemChain local MiniLM
        // -------------------------------------------------------------
        const embedding = await client.embedSingle(userMessage);
        if (!embedding) {
          log.debug("Embed unavailable, skipping recall");
          return {};
        }

        // -------------------------------------------------------------
        // Step 3: Recall relevant memories
        // -------------------------------------------------------------
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

        // -------------------------------------------------------------
        // Step 4: Store recall_context for later /log correlation
        // This enables negative feedback detection:
        // when user says "wrong", MemChain knows WHICH memory was wrong
        // -------------------------------------------------------------
        sessions.setRecallContext(sessionKey, result.memories);

        // -------------------------------------------------------------
        // Step 5: Format memories for system prompt injection
        // Identity memories are always first (guaranteed by MemChain)
        // -------------------------------------------------------------
        const memoryContext = formatMemoriesForPrompt(result.memories);

        log.debug("Recall injected", {
          sessionKey,
          memoryCount: result.memories.length,
          tokenEstimate: result.token_estimate,
          layers: summarizeLayers(result.memories),
        });

        // -------------------------------------------------------------
        // Step 6: Return for OpenClaw to prepend to system prompt
        // prependSystemContext goes into system prompt space,
        // allowing provider caching (static per session)
        // -------------------------------------------------------------
        return {
          prependSystemContext: memoryContext,
        };
      } catch (err: unknown) {
        // -------------------------------------------------------------
        // CRITICAL: Never throw — return empty to continue without memory
        // -------------------------------------------------------------
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Recall hook failed, continuing without memory", {
          error: message,
          sessionKey,
        });
        return {};
      }
    },
    {
      // High priority: inject memory context before other plugins
      // (e.g. style guides, company policies) so the LLM sees identity first
      priority: 100,
    },
  );
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Extract the most recent user message from the session messages array.
 *
 * OpenClaw messages can have string or structured content (multimodal).
 * We extract text content only — images/audio are not relevant for recall.
 *
 * @param messages - Session messages array from OpenClaw context
 * @returns Last user message as string, or null if none found
 */
function extractLastUserMessage(
  messages: Array<{ role: string; content: string | unknown }>,
): string | null {
  if (!messages?.length) return null;

  // Walk backwards to find the most recent user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    // Handle string content (most common case)
    if (typeof msg.content === "string") {
      const trimmed = msg.content.trim();
      // Skip very short messages (e.g. "ok", "yes") — not useful for recall
      if (trimmed.length >= 3) {
        return trimmed;
      }
      continue;
    }

    // Handle structured content (multimodal: text + image)
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

/**
 * Create a summary of recalled memory layers for debug logging.
 * Example output: "identity:2, knowledge:3, episode:5"
 */
function summarizeLayers(
  memories: Array<{ layer: string }>,
): string {
  const counts: Record<string, number> = {};
  for (const m of memories) {
    counts[m.layer] = (counts[m.layer] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([layer, count]) => `${layer}:${count}`)
    .join(", ");
}
