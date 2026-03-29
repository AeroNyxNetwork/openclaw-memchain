/**
 * ============================================
 * File: src/hooks/log-hook.ts
 * ============================================
 * Creation Reason: Collect conversation turns during session and flush
 *   to MemChain /log on session end. Rule engine auto-extracts identities,
 *   preferences, allergies, and detects negative feedback.
 *
 * Modification Reason (v0.3.2):
 *   BUG FIX 1 — All three hook event names were wrong, causing hooks to be
 *   silently ignored by OpenClaw. Verified correct names from OpenClaw
 *   2026.3.7 source (deliver-Draic8X1.js):
 *
 *   WRONG (all previous versions)     CORRECT (v0.3.2)
 *   ─────────────────────────────     ────────────────
 *   "message:preprocessed"         →  "message_received"
 *   "message:response"             →  "agent_end"
 *   "session:end"                  →  "session_end"
 *
 *   BUG FIX 2 — message_received does NOT fire on Web/WebSocket path.
 *   Verified: Web UI messages go through a different dispatch path that
 *   does not call runMessageReceived(). User turns were never collected
 *   when using the Web interface.
 *
 *   Fix: in the agent_end handler, also extract the last user message
 *   from event.messages[] as a fallback. A dedup check prevents double
 *   collection when message_received DID fire (e.g. Telegram/WhatsApp).
 *
 * Main Logical Flow:
 *   1. message_received fires when user message arrives (channel path only)
 *      → extract user content from event.content
 *      → addTurn("user", ...) into SessionStore
 *   2. agent_end fires after LLM finishes full reply (all paths)
 *      → extract last USER message from event.messages[] if not already collected
 *      → extract last ASSISTANT message from event.messages[]
 *      → addTurn() both into SessionStore (with dedup for user turn)
 *   3. session_end fires when conversation closes
 *      → getTurns() — has both user + assistant turns
 *      → client.log() — client handles mode-based suppression
 *      → clear() SessionStore
 *
 * ⚠️ Important Note for Next Developer:
 *   - /log is the SAFETY NET — even if remember-tool isn't called,
 *     the rule engine extracts memories from raw conversation.
 *   - Do NOT add mode checks here. Mode filtering lives in client.ts → log().
 *   - recall_context enables negative feedback detection server-side.
 *   - event names use underscores NOT colons: session_end not session:end
 *   - agent_end.messages is the full history — take the LAST entries
 *   - Web/WebSocket path does NOT fire message_received — use agent_end fallback
 *
 * Last Modified: v0.3.2 — Fixed hook event names + added user turn fallback
 *                         in agent_end for Web/WebSocket path
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

/** message_received event — fires when user message arrives (channel path) */
interface MessageReceivedEvent {
  content: string;
  from?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

/** agent_end event — fires after LLM finishes full reply (all paths) */
interface AgentEndEvent {
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
    options?: { name?: string; priority?: number },
  ): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text!.trim())
      .join(" ")
      .trim();
  }
  return "";
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
  // Hook 1: Collect USER turns via message_received
  //
  // Fires on channel paths (Telegram, WhatsApp, etc.) BEFORE LLM responds.
  // Does NOT fire on Web/WebSocket path — agent_end handles that as fallback.
  // -----------------------------------------------------------------------
  api.on(
    "message_received",
    async (rawEvent: unknown, ctx: HookCtx): Promise<void> => {
      if (!cfg.enableAutoLog) return;
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return;

      const event = rawEvent as MessageReceivedEvent;
      const trimmed = (event?.content ?? "").trim();
      if (!trimmed) return;

      const { overflow } = sessions.addTurn(sessionKey, {
        role: "user",
        content: trimmed,
      });
      if (overflow) {
        log.warn("[MemChain] Session turn cap reached (200), oldest turns dropped", {
          sessionKey, role: "user",
        });
        sessions.markOverflowWarned(sessionKey);
      }
      log.debug("[MemChain] Turn collected (user via message_received)", {
        sessionKey, length: trimmed.length,
      });
    },
    { name: "memchain.collect-user-turn" },
  );

  // -----------------------------------------------------------------------
  // Hook 2: Collect BOTH user and assistant turns via agent_end
  //
  // Fires after LLM finishes replying on ALL paths including Web/WebSocket.
  // event.messages contains the full conversation history.
  //
  // User turn: extracted as fallback — dedup check prevents double-collection
  // when message_received already fired (e.g. Telegram/WhatsApp).
  //
  // Assistant turn: always extracted here (no other reliable source).
  // -----------------------------------------------------------------------
  api.on(
    "agent_end",
    async (rawEvent: unknown, ctx: HookCtx): Promise<void> => {
      if (!cfg.enableAutoLog) return;
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return;

      const event = rawEvent as AgentEndEvent;
      if (!event?.messages?.length) return;

      const reversed = [...event.messages].reverse();

      // --- User turn fallback (for Web/WebSocket path) ---
      const lastUser = reversed.find((m) => m.role === "user");
      if (lastUser) {
        const userText = extractText(lastUser.content);
        if (userText) {
          const existing = sessions.getTurns(sessionKey);
          const alreadyCollected = existing.some(
            (t) => t.role === "user" && t.content === userText,
          );
          if (!alreadyCollected) {
            const { overflow } = sessions.addTurn(sessionKey, {
              role: "user",
              content: userText,
            });
            if (overflow) {
              log.warn("[MemChain] Session turn cap reached (200), oldest turns dropped", {
                sessionKey, role: "user",
              });
              sessions.markOverflowWarned(sessionKey);
            }
            log.warn("[MemChain] Turn collected (user via agent_end)", {
              sessionKey, length: userText.length,
            });
          }
        }
      }

      // --- Assistant turn ---
      const lastAssistant = reversed.find((m) => m.role === "assistant");
      if (!lastAssistant) return;

      const assistantText = extractText(lastAssistant.content);
      if (!assistantText) return;

      const { overflow } = sessions.addTurn(sessionKey, {
        role: "assistant",
        content: assistantText,
      });
      if (overflow) {
        log.warn("[MemChain] Session turn cap reached (200), oldest turns dropped", {
          sessionKey, role: "assistant",
        });
        sessions.markOverflowWarned(sessionKey);
      }
      log.warn("[MemChain] Turn collected (assistant)", {
        sessionKey, length: assistantText.length,
      });
    },
    { name: "memchain.collect-assistant-turn" },
  );

  // -----------------------------------------------------------------------
  // Hook 3: Flush all turns to MemChain /log on session end
  //
  // "session_end" fires when a session closes.
  // ctx.sessionKey identifies which session is ending.
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
              sessionKey, turnsLost: turns.length,
            });
          } else {
            log.debug("[MemChain] /log skipped", {
              mode: cfg.mode, sessionKey, turnsCollected: turns.length,
            });
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("[MemChain] Log hook failed", {
          error: message, sessionKey, turnsLost: turns.length,
        });
      } finally {
        sessions.clear(sessionKey);
      }
    },
    { name: "memchain.session-log" },
  );
}
