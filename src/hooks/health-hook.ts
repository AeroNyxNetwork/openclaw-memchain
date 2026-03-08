/**
 * ============================================
 * File: src/hooks/log-hook.ts
 * ============================================
 * Creation Reason: Collect conversation turns during the session and flush
 *   them to MemChain's /log endpoint when the session ends. The /log rule
 *   engine auto-extracts identities, preferences, allergies (P0-P6 patterns)
 *   and detects negative feedback ("wrong", "搞错了") for memory correction.
 *
 * Main Functionality:
 *   - Hook "message:preprocessed" → collect each user message as a turn
 *   - Hook "session:end" → batch-send all turns to MemChain /log
 *   - Include recall_context for negative feedback correlation
 *   - Graceful cleanup of session state after logging
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient.log)
 *   - src/core/session-store.ts (SessionStore)
 *   - src/types/memchain.ts (MemChainPluginConfig)
 *   - OpenClaw Plugin SDK: api.registerHook()
 *
 * Main Logical Flow:
 *   1. message:preprocessed fires for each inbound message
 *   2. Extract user content (text or transcribed audio)
 *   3. Store as turn in SessionStore
 *   4. session:end fires when conversation terminates
 *   5. Retrieve all turns + recall_context from SessionStore
 *   6. POST /api/mpi/log with turns + recall_context
 *   7. Clear session state to free memory
 *
 * ⚠️ Important Note for Next Developer:
 *   - /log is the SAFETY NET — even if remember-tool isn't called,
 *     the rule engine extracts memories from raw conversation
 *   - recall_context is optional but HIGHLY recommended — without it,
 *     negative feedback detection can't identify which memory was wrong
 *   - session:end may not fire in all cases (e.g. gateway crash) —
 *     SessionStore's TTL cleanup handles orphaned sessions
 *   - Assistant messages are also collected to give the rule engine
 *     full conversation context for P3 (correction) detection
 *
 * Last Modified: v0.1.0 - Initial creation
 * ============================================
 */

import type { MemChainClient } from "../core/client.js";
import type { SessionStore } from "../core/session-store.js";
import type { MemChainPluginConfig } from "../types/memchain.js";

/** Minimal logger interface */
interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * OpenClaw hook event structure.
 * Fields vary by event type — we use the union of what we need.
 */
interface HookEvent {
  type: string;
  action: string;
  sessionKey: string;
  timestamp: Date;
  messages: string[];
  context: {
    body?: string;
    transcript?: string;
    responseText?: string;
    sessionEntry?: unknown;
    senderId?: string;
  };
}

/** Minimal Plugin API interface for hook registration */
interface PluginApi {
  registerHook(
    event: string,
    handler: (event: HookEvent) => Promise<void>,
    options?: { name?: string; description?: string },
  ): void;
}

// ---------------------------------------------------------------------------
// Hook Registration
// ---------------------------------------------------------------------------

/**
 * Register log hooks for turn collection and session-end flushing.
 *
 * Registers two hooks:
 * 1. "message:preprocessed" — collects each user message turn
 * 2. "session:end" — flushes all turns to MemChain /log
 *
 * @param api      - OpenClaw Plugin API
 * @param client   - MemChain HTTP client
 * @param sessions - In-memory session state store
 * @param cfg      - Plugin configuration
 * @param log      - Plugin logger
 */
export function registerLogHook(
  api: PluginApi,
  client: MemChainClient,
  sessions: SessionStore,
  cfg: MemChainPluginConfig,
  log: PluginLogger,
): void {
  // -----------------------------------------------------------------------
  // Hook 1: Collect user messages as conversation turns
  // -----------------------------------------------------------------------
  api.registerHook(
    "message:preprocessed",
    async (event: HookEvent): Promise<void> => {
      if (!cfg.enableAutoLog) return;

      const sessionKey = event.sessionKey;
      if (!sessionKey) return;

      // Extract user message content.
      // "body" is the processed text; "transcript" is for audio messages.
      const content = event.context?.body || event.context?.transcript;
      if (!content || typeof content !== "string") return;

      const trimmed = content.trim();
      if (!trimmed) return;

      sessions.addTurn(sessionKey, {
        role: "user",
        content: trimmed,
      });

      log.debug("Turn collected", {
        sessionKey,
        role: "user",
        length: trimmed.length,
      });
    },
    {
      name: "memchain.collect-user-turn",
      description: "Collect user messages for MemChain /log rule engine",
    },
  );

  // -----------------------------------------------------------------------
  // Hook 2: Flush all turns to MemChain /log on session end
  // -----------------------------------------------------------------------
  api.registerHook(
    "session:end",
    async (event: HookEvent): Promise<void> => {
      if (!cfg.enableAutoLog) return;

      const sessionKey = event.sessionKey;
      if (!sessionKey) return;

      // Retrieve collected turns
      const turns = sessions.getTurns(sessionKey);
      if (!turns.length) {
        log.debug("No turns to log", { sessionKey });
        sessions.clear(sessionKey);
        return;
      }

      // Retrieve recall_context for negative feedback correlation
      const recallCtx = sessions.getRecallContext(sessionKey);
      const sessionId = sessions.getSessionId(sessionKey);

      try {
        // Build recall_context JSON for MemChain's negative feedback detection.
        // Format matches what log_handler.rs expects:
        // [{"id":"record_id","score":1.3,"features":[]}]
        let recallContextJson: string | undefined;
        if (recallCtx?.length) {
          recallContextJson = JSON.stringify(
            recallCtx.map((m) => ({
              id: m.record_id,
              score: m.score,
              features: [],
            })),
          );
        }

        const result = await client.log({
          session_id: sessionId || sessionKey,
          turns,
          source_ai: cfg.sourceAi,
          recall_context: recallContextJson,
        });

        if (result) {
          log.info("Session logged to MemChain", {
            sessionKey,
            sessionId,
            turnsLogged: result.logged,
            turnsCollected: turns.length,
            hasRecallContext: !!recallContextJson,
          });
        } else {
          log.warn("Failed to log session — MemChain unavailable", {
            sessionKey,
            turnsLost: turns.length,
          });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Log hook failed", {
          error: message,
          sessionKey,
          turnsLost: turns.length,
        });
      } finally {
        // Always clear session state to prevent memory leaks,
        // even if /log failed — the data is transient by design
        sessions.clear(sessionKey);
      }
    },
    {
      name: "memchain.session-log",
      description: "Flush conversation turns to MemChain /log on session end",
    },
  );
}
