/**
 * ============================================
 * File: src/hooks/log-hook.ts
 * ============================================
 * Creation Reason: Collect conversation turns during session and flush
 *   to MemChain /log on session end. Rule engine auto-extracts identities,
 *   preferences, allergies, and detects negative feedback.
 *
 * Modification Reason (v0.3.2):
 *   BUG FIX — All three hook event names were wrong, causing hooks to be
 *   silently ignored by OpenClaw. Verified correct names from OpenClaw
 *   2026.3.7 source (deliver-Draic8X1.js):
 *
 *   WRONG (all previous versions)     CORRECT (v0.3.2)
 *   ─────────────────────────────     ────────────────
 *   "message:preprocessed"         →  "message_received"
 *   "message:response"             →  "agent_end"
 *   "session:end"                  →  "session_end"
 *
 *   Additionally, event object shapes were wrong. Verified from source:
 *
 *   message_received event:
 *     event.content   — user message content (string)
 *     event.from      — sender identifier
 *     ctx.sessionKey  — session identifier
 *
 *   agent_end event:
 *     event.messages  — full message history array (role/content pairs)
 *     event.success   — boolean
 *     event.durationMs — number
 *     ctx.sessionKey  — session identifier
 *
 *   session_end event:
 *     ctx.sessionKey  — session identifier
 *     (no content in event itself)
 *
 *   Since agent_end carries the full messages array, we extract the last
 *   assistant message from it rather than reading a responseText field
 *   (which doesn't exist in this hook's event).
 *
 * Main Functionality:
 *   - Hook "message_received" → collect user turn from event.content
 *   - Hook "agent_end" → collect last assistant turn from event.messages
 *   - Hook "session_end" → batch-send all turns to MemChain /log
 *   - Include recall_context for negative feedback correlation
 *   - Mode filtering delegated entirely to MemChainClient.log()
 *
 * Dependencies:
 *   - src/core/client.ts   (MemChainClient — handles mode-aware /log suppression)
 *   - src/core/session-store.ts (SessionStore)
 *   - src/types/memchain.ts (MemChainPluginConfig, Memory)
 *
 * Main Logical Flow:
 *   1. message_received fires when user message arrives
 *      → extract content from event.content
 *      → addTurn("user", ...) into SessionStore
 *   2. agent_end fires after LLM finishes full reply
 *      → find last assistant message in event.messages[]
 *      → addTurn("assistant", ...) into SessionStore
 *      → if overflow, emit warn once
 *   3. session_end fires when conversation closes
 *      → getTurns() — now has both user + assistant turns
 *      → client.log() — client handles mode-based suppression
 *      → clear() SessionStore
 *
 * ⚠️ Important Note for Next Developer:
 *   - /log is the SAFETY NET — even if remember-tool isn't called,
 *     the rule engine extracts memories from raw conversation.
 *   - Do NOT add mode checks here. Mode filtering lives in client.ts → log().
 *   - recall_context enables negative feedback detection server-side.
 *   - event names use underscores NOT colons: session_end not session:end
 *   - agent_end.messages is the full history — take the LAST assistant entry
 *   - message_received.content is the raw user message string
 *
 * Last Modified: v0.3.2 — Fixed all three hook event names + event shapes
 *                         (was silently ignored by OpenClaw since v0.1.0)
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

// ---------------------------------------------------------------------------
// Event type definitions (verified from OpenClaw 2026.3.7 source)
// ---------------------------------------------------------------------------

/** message_received event — fires when user message arrives */
interface MessageReceivedEvent {
  /** Raw message content from the user */
  content: string;
  /** Sender identifier */
  from?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

/** agent_end event — fires after LLM finishes full reply */
interface AgentEndEvent {
  /** Full conversation message history including the new assistant reply */
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    timestamp?: number;
  }>;
  success: boolean;
  error?: string;
  durationMs?: number;
}

/** Hook context — always has sessionKey */
interface HookCtx {
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  workspaceDir?: string;
  messageProvider?: string;
}

interface PluginApi {
  on(
    event: string,
    handler: (event: unknown, ctx: HookCtx) => Promise<void>,
    options?: { name?: string; description?: string; priority?: number },
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
  // "message_received" fires when a user message arrives.
  // event.content contains the raw user message string.
  //
  // v0.3.2 FIX: was "message:preprocessed" — doesn't exist in OpenClaw.
  //             event shape was also wrong (was reading context.body).
  // -----------------------------------------------------------------------
  api.on(
    "message_received",
    async (rawEvent: unknown, ctx: HookCtx): Promise<void> => {
      if (!cfg.enableAutoLog) return;

      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return;

      const event = rawEvent as MessageReceivedEvent;
      const content = event?.content;
      if (!content || typeof content !== "string") return;

      const trimmed = content.trim();
      if (!trimmed) return;

      const { overflow } = sessions.addTurn(sessionKey, {
        role: "user",
        content: trimmed,
      });

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
    { name: "memchain.collect-user-turn" },
  );

  // -----------------------------------------------------------------------
  // Hook 2: Collect ASSISTANT turns
  //
  // "agent_end" fires after the LLM finishes its complete reply.
  // event.messages contains the full conversation history — we extract
  // the last message with role "assistant".
  //
  // v0.3.2 FIX: was "message:response" — doesn't exist in OpenClaw.
  //             event shape was also wrong (was reading context.responseText).
  // -----------------------------------------------------------------------
  api.on(
    "agent_end",
    async (rawEvent: unknown, ctx: HookCtx): Promise<void> => {
      if (!cfg.enableAutoLog) return;

      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return;

      const event = rawEvent as AgentEndEvent;
      if (!event?.messages?.length) return;

      const lastAssistant = [...event.messages]
        .reverse()
        .find((m) => m.role === "assistant");

      if (!lastAssistant) return;

      let text: string;
      if (typeof lastAssistant.content === "string") {
        text = lastAssistant.content.trim();
      } else if (Array.isArray(lastAssistant.content)) {
        text = lastAssistant.content
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text!.trim())
          .join(" ")
          .trim();
      } else {
        return;
      }

      if (!text) return;

      const { overflow } = sessions.addTurn(sessionKey, {
        role: "assistant",
        content: text,
      });

      if (overflow) {
        log.warn("[MemChain] Session turn cap reached (200), oldest turns being dropped", {
          sessionKey,
          role: "assistant",
        });
        sessions.markOverflowWarned(sessionKey);
      }

      log.debug("[MemChain] Turn collected (assistant)", {
        sessionKey,
        length: text.length,
      });
    },
    { name: "memchain.collect-assistant-turn" },
  );

  // -----------------------------------------------------------------------
  // Hook 3: Flush all turns to MemChain /log on session end
  //
  // "session_end" fires when a session closes.
  // ctx.sessionKey identifies which session is ending.
  //
  // v0.3.2 FIX: was "session:end" — correct name is "session_end".
  // -----------------------------------------------------------------------
  api.on(
    "session_end",
    async (_rawEvent: unknown, ctx: HookCtx): Promise<void> => {
      if (!cfg.enableAutoLog) return;

      const sessionKey = ctx?.sessionKey;
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
        //   cloud  → silently returns null (403 expected)
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
        sessions.clear(sessionKey);
      }
    },
    { name: "memchain.session-log" },
  );
}
