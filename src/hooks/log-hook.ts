/**
 * ============================================
 * File: src/hooks/log-hook.ts
 * ============================================
 * Creation Reason: Collect conversation turns during session and flush
 *   to MemChain /log on session end. Rule engine auto-extracts identities,
 *   preferences, allergies, and detects negative feedback.
 *
 * Modification Reason (v0.3.0):
 *   BUG FIX 1 — Only user turns were collected; assistant replies were never
 *   added to the turn buffer. /log was sending one-sided conversations, which
 *   severely degraded the rule engine's entity extraction and negative feedback
 *   detection (both require seeing both sides of the dialogue).
 *
 *   ROOT CAUSE of BUG FIX 1: The previous attempt tried to read assistant
 *   content from event.context.responseText inside message:preprocessed.
 *   That hook fires BEFORE the LLM responds, so responseText is always
 *   undefined at that point. Assistant turns must be collected in a
 *   SEPARATE hook that fires AFTER the LLM responds (message:response or
 *   equivalent post-response event).
 *
 *   BUG FIX 2 — Cloud mode was being silently skipped at the hook layer
 *   (same early-return as remote mode), but client.ts already handles the
 *   remote/cloud /log suppression internally. Double-suppression meant cloud
 *   mode turns were never collected, making it impossible to add cloud /log
 *   support in the future without changing two places.
 *
 *   BUG FIX 3 — SessionStore.addTurn() now returns { overflow: boolean }.
 *   Hook checks this and emits a warn log once per session when the 200-turn
 *   cap is hit, then marks the session so it doesn't spam the log.
 *
 * Main Functionality:
 *   - Hook "message:preprocessed" → collect user message turns
 *   - Hook "message:preprocessed" → collect assistant reply turns (NEW)
 *   - Hook "session:end" → batch-send turns to MemChain /log
 *   - Include recall_context for negative feedback correlation
 *   - Mode filtering delegated entirely to MemChainClient.log()
 *
 * Dependencies:
 *   - src/core/client.ts   (MemChainClient — handles mode-aware /log suppression)
 *   - src/core/session-store.ts (SessionStore)
 *   - src/types/memchain.ts (MemChainPluginConfig, Memory)
 *
 * Main Logical Flow:
 *   1. message:preprocessed fires BEFORE LLM responds
 *      → extract user content from event.context.body / transcript
 *      → addTurn("user", ...) into SessionStore
 *   2. message:response (or equivalent post-LLM hook) fires AFTER LLM responds
 *      → extract assistant content from event.context.responseText
 *      → addTurn("assistant", ...) into SessionStore
 *      → if SessionStore.addTurn() returns overflow=true, emit warn once
 *   3. session:end fires when conversation closes
 *      → getTurns() from SessionStore (now contains both user + assistant)
 *      → build LogRequest with session_id + turns + recall_context
 *      → client.log() — client decides whether to skip based on mode
 *      → clear() SessionStore regardless of success/failure
 *
 * ⚠️ Important Note for Next Developer:
 *   - /log is the SAFETY NET — even if remember-tool isn't called,
 *     the rule engine extracts memories from raw conversation.
 *   - Do NOT add mode checks here. Mode filtering lives in client.ts → log().
 *     Adding it in two places caused the cloud-mode double-suppression bug.
 *   - recall_context enables negative feedback detection on the server side.
 *   - Both user AND assistant turns are required for the rule engine to work.
 *   - CRITICAL: Never try to read responseText in message:preprocessed.
 *     That hook fires before the LLM responds — responseText will always
 *     be undefined/empty at that point. Use a post-response hook instead.
 *   - The hook name for post-LLM response may vary by OpenClaw version.
 *     "message:response" is the documented name as of OpenClaw 2026.3.7.
 *     If assistant turns stop being collected, check if the hook event name
 *     has changed in newer OpenClaw releases.
 *
 * Last Modified: v0.3.0 — Fixed assistant turn collection (wrong hook timing),
 *                         removed duplicate mode-gate, added overflow warning
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
    responseText?: string;      // assistant reply content
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
  // Hook 1: Collect USER turns
  //
  // Fires BEFORE the LLM responds (message preprocessing phase).
  // ONLY collect user content here — responseText is undefined at this point.
  // -----------------------------------------------------------------------
  api.registerHook(
    "message:preprocessed",
    async (event: HookEvent): Promise<void> => {
      if (!cfg.enableAutoLog) return;

      const sessionKey = event.sessionKey;
      if (!sessionKey) return;

      const userContent = event.context?.body || event.context?.transcript;
      if (!userContent || typeof userContent !== "string") return;

      const trimmed = userContent.trim();
      if (!trimmed) return;

      const { overflow } = sessions.addTurn(sessionKey, { role: "user", content: trimmed });

      if (overflow) {
        log.warn("[MemChain] Session turn cap reached (200), oldest turns being dropped", {
          sessionKey,
          role: "user",
        });
        sessions.markOverflowWarned(sessionKey);
      }

      log.debug("[MemChain] Turn collected (user)", {
        sessionKey,
        length: trimmed.length,
      });
    },
    {
      name: "memchain.collect-user-turn",
      description: "Collect user messages for MemChain /log rule engine",
    },
  );

  // -----------------------------------------------------------------------
  // Hook 2: Collect ASSISTANT turns
  //
  // Fires AFTER the LLM responds. This is the only correct place to read
  // responseText — it is always undefined/empty in message:preprocessed
  // because that hook fires before the LLM has produced a reply.
  //
  // ⚠️ If "message:response" is not a valid event in your OpenClaw version,
  //    check the OpenClaw changelog. As of 2026.3.7 this is the documented
  //    post-response hook event name.
  // -----------------------------------------------------------------------
  api.registerHook(
    "message:response",
    async (event: HookEvent): Promise<void> => {
      if (!cfg.enableAutoLog) return;

      const sessionKey = event.sessionKey;
      if (!sessionKey) return;

      const assistantContent = event.context?.responseText;
      if (!assistantContent || typeof assistantContent !== "string") return;

      const trimmed = assistantContent.trim();
      if (!trimmed) return;

      const { overflow } = sessions.addTurn(sessionKey, { role: "assistant", content: trimmed });

      if (overflow) {
        log.warn("[MemChain] Session turn cap reached (200), oldest turns being dropped", {
          sessionKey,
          role: "assistant",
        });
        sessions.markOverflowWarned(sessionKey);
      }

      log.debug("[MemChain] Turn collected (assistant)", {
        sessionKey,
        length: trimmed.length,
      });
    },
    {
      name: "memchain.collect-assistant-turn",
      description: "Collect assistant replies for MemChain /log rule engine",
    },
  );

  // -----------------------------------------------------------------------
  // Hook 2: Flush all turns to MemChain /log on session end
  //
  // v0.3.0 FIX: Removed early-return for remote/cloud modes.
  // Mode filtering is handled entirely inside client.log() — it already
  // returns null silently for remote and cloud modes. Duplicating the check
  // here was causing cloud turns to never be collected (data loss), and
  // would prevent future cloud /log support from working without touching
  // two files.
  // -----------------------------------------------------------------------
  api.registerHook(
    "session:end",
    async (event: HookEvent): Promise<void> => {
      if (!cfg.enableAutoLog) return;

      const sessionKey = event.sessionKey;
      if (!sessionKey) return;

      const turns = sessions.getTurns(sessionKey);
      if (!turns.length) {
        log.debug("[MemChain] No turns to log", { sessionKey });
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

        // client.log() is mode-aware:
        //   local  → POST /api/mpi/log
        //   remote → silently returns null (403 expected)
        //   cloud  → silently returns null (403 expected, future-proofed)
        const result = await client.log({
          session_id: sessionId || sessionKey,
          turns,
          source_ai: cfg.sourceAi,
          recall_context: recallContextJson,
        });

        if (result) {
          log.info("[MemChain] Session logged", {
            sessionKey,
            sessionId,
            turnsLogged: result.logged,
            turnsCollected: turns.length,
            hasRecallContext: !!recallContextJson,
          });
        } else {
          // null = either mode-suppressed (remote/cloud) or server unavailable
          // Only warn if local mode, where /log is expected to work
          if (cfg.mode === "local") {
            log.warn("[MemChain] Failed to log session — MemChain unavailable", {
              sessionKey,
              turnsLost: turns.length,
            });
          } else {
            log.debug("[MemChain] /log skipped", {
              mode: cfg.mode,
              sessionKey,
              turnsCollected: turns.length,
            });
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("[MemChain] Log hook failed", {
          error: message,
          sessionKey,
          turnsLost: turns.length,
        });
      } finally {
        // Always clear — don't leak session data regardless of outcome
        sessions.clear(sessionKey);
      }
    },
    {
      name: "memchain.session-log",
      description: "Flush conversation turns to MemChain /log on session end",
    },
  );
}
