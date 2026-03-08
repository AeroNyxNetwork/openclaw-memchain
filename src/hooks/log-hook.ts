/**
 * ============================================
 * File: src/hooks/log-hook.ts
 * ============================================
 * Creation Reason: Collect conversation turns during session and flush
 *   to MemChain /log on session end. Rule engine auto-extracts identities,
 *   preferences, allergies, and detects negative feedback.
 *
 * Main Functionality:
 *   - Hook "message:preprocessed" → collect user message turns
 *   - Hook "session:end" → batch-send turns to MemChain /log
 *   - Include recall_context for negative feedback correlation
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient)
 *   - src/core/session-store.ts (SessionStore)
 *   - src/types/memchain.ts (MemChainPluginConfig, Memory)
 *
 * ⚠️ Important Note for Next Developer:
 *   - /log is the SAFETY NET — even if remember-tool isn't called,
 *     the rule engine extracts memories from raw conversation
 *   - recall_context enables negative feedback detection
 *
 * Last Modified: v0.1.0-fix1 — Fixed: correct imports, typed map() parameter
 * ============================================
 */

import type { MemChainClient } from "../core/client.js";
import type { SessionStore } from "../core/session-store.js";
import type { MemChainPluginConfig, Memory } from "../types/memchain.js";

/** Minimal logger interface */
interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

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

      const turns = sessions.getTurns(sessionKey);
      if (!turns.length) {
        log.debug("No turns to log", { sessionKey });
        sessions.clear(sessionKey);
        return;
      }

      const recallCtx = sessions.getRecallContext(sessionKey);
      const sessionId = sessions.getSessionId(sessionKey);

      try {
        let recallContextJson: string | undefined;
        if (recallCtx?.length) {
          recallContextJson = JSON.stringify(
            recallCtx.map((m: Memory) => ({
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
        sessions.clear(sessionKey);
      }
    },
    {
      name: "memchain.session-log",
      description: "Flush conversation turns to MemChain /log on session end",
    },
  );
}
