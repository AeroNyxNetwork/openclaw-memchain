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
 *   SEPARATE hook that fires AFTER the LLM responds.
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
 * Modification Reason (v0.3.2):
 *   BUG FIX — Wrong hook event names. OpenClaw does NOT have
 *   "message:preprocessed", "message:response", or "session:end".
 *   Verified from OpenClaw 2026.3.7 source:
 *     user turn   → "message_received"   (fires when user message arrives)
 *     asst turn   → "agent_end"          (fires after LLM finishes replying)
 *     session end → "session_end"        (fires when session closes)
 *   All three hooks were silently ignored by OpenClaw because the event
 *   names didn't match any known events — that's why "Turn collected" never
 *   appeared in logs and /log only received empty turn arrays.
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
 *   1. message_received fires when user message arrives (BEFORE LLM)
 *      → extract user content from event.context.body / transcript
 *      → addTurn("user", ...) into SessionStore
 *   2. agent_end fires after LLM finishes replying
 *      → extract assistant content from event.context.responseText
 *      → addTurn("assistant", ...) into SessionStore
 *      → if SessionStore.addTurn() returns overflow=true, emit warn once
 *   3. session_end fires when conversation closes
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
 *   - VERIFIED event names (OpenClaw 2026.3.7):
 *       user turn   → "message_received"
 *       asst turn   → "agent_end"
 *       session end → "session_end"
 *     Do NOT use "message:preprocessed", "message:response", "session:end"
 *     (colon variants) — they don't exist and are silently ignored.
 *
 * Last Modified: v0.3.2 — Fixed all three hook event names
 *                         (message_received / agent_end / session_end)
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
    responseText?: string;      // assistant reply — available in agent_end
    reply?: string;             // alternate field name for assistant reply
    text?: string;              // alternate field name for user message
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
  // "message_received" fires when a user message arrives, BEFORE LLM responds.
  // v0.3.2 FIX: was "message:preprocessed" — colon variant doesn't exist in
  // OpenClaw 2026.3.7, so this hook was silently never registered.
  // -----------------------------------------------------------------------
  api.registerHook(
    "message_received",
    async (event: HookEvent): Promise<void> => {
      if (!cfg.enableAutoLog) return;

      const sessionKey = event.sessionKey;
      if (!sessionKey) return;

      // Try all known field names for user message content
      const userContent =
        event.context?.body ||
        event.context?.transcript ||
        event.context?.text;
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
  // "agent_end" fires after the LLM finishes its full reply.
  // v0.3.2 FIX: was "message:response" — colon variant doesn't exist in
  // OpenClaw 2026.3.7, so this hook was silently never registered.
  // Verified available events from OpenClaw source: agent_end, session_end,
  // message_received, before_prompt_build, before_agent_start, llm_output.
  // -----------------------------------------------------------------------
  api.registerHook(
    "agent_end",
    async (event: HookEvent): Promise<void> => {
      if (!cfg.enableAutoLog) return;

      const sessionKey = event.sessionKey;
      if (!sessionKey) return;

      // Try all known field names for assistant reply content
      const assistantContent =
        event.context?.responseText ||
        event.context?.reply;
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
  // Hook 3: Flush all turns to MemChain /log on session end
  //
  // v0.3.2 FIX: was "session:end" — correct name is "session_end"
  //             (underscore, not colon). Colon variant doesn't exist.
  // -----------------------------------------------------------------------
  api.registerHook(
    "session_end",
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
