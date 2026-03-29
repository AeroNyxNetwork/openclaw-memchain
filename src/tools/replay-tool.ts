/**
 * ============================================
 * File: src/tools/replay-tool.ts
 * ============================================
 * Creation Reason: Replay previous conversation sessions.
 *   Developers and users can review what was discussed in past sessions.
 *   Supports encrypted content decryption in remote/cloud modes.
 *
 * Modification Reason (v0.3.0):
 *   No logic changes. Added standard modification header block for consistency
 *   with all other files in the plugin (required by project comment standards).
 *
 * Main Functionality:
 *   - Accept session_id + optional max_turns from LLM tool call
 *   - GET /sessions/:id/conversation — fetch decrypted turn list
 *   - GET /sessions/:id — fetch session title + summary for display
 *   - Format turns into readable output, truncated at 200 chars each
 *   - Show overflow indicator if turns exceed max_turns
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient.getConversation, .getSession)
 *
 * ⚠️ Important Note for Next Developer:
 *   - Requires MemChain v2.5.0+ (GET /sessions/:id/conversation)
 *   - Encrypted turns show as "(encrypted)" if decryption fails at client layer
 *   - Content is truncated to 200 chars per turn for LLM context efficiency
 *   - Use memchain_search to find the session_id first, then replay
 *   - Two sequential HTTP calls (getConversation + getSession) are intentional:
 *     getConversation is the primary data source, getSession is metadata only.
 *     getSession failure should not block the result — it's display-only.
 *
 * Last Modified: v0.3.0 — Initial creation + standard comment block added
 * ============================================
 */

import type { MemChainClient } from "../core/client.js";

interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface PluginApi {
  registerTool(
    factory: (ctx: any) => any | any[] | null,
    options: { names: string[] },
  ): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface ReplayInput {
  session_id: string;
  max_turns?: number;
}

export function registerReplayTool(
  api: PluginApi,
  client: MemChainClient,
  log: PluginLogger,
): void {
  api.registerTool(
    (_ctx) => ({
      name: "memchain_replay",
      description:
        "Replay a previous conversation session. Shows the turns (user + assistant messages) " +
        "from a past session. Use memchain_search to find the session_id first, " +
        "then call this to review the full conversation.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "Session ID to replay. Get this from memchain_search results.",
          },
          max_turns: {
            type: "number",
            description: "Maximum turns to show (default: 20, max: 100)",
          },
        },
        required: ["session_id"],
      },
      execute: async (_toolCallId: string, input: ReplayInput) => {
        const sessionId = input.session_id?.trim();
        if (!sessionId) {
          return { result: "No session_id provided. Use memchain_search to find sessions first." };
        }

        const maxTurns = Math.min(Math.max(input.max_turns || 20, 1), 100);

        try {
          // Primary: fetch conversation turns
          const convo = await client.getConversation(sessionId);

          if (!convo) {
            return {
              result:
                "Conversation replay unavailable — MemChain may not support this feature yet.",
            };
          }

          if (!convo.turns || convo.turns.length === 0) {
            return { result: `No conversation data found for session ${sessionId}.` };
          }

          // Secondary: fetch session metadata (title + summary) for display only.
          // Failure here is non-blocking — convo data is the primary result.
          const session = await client.getSession(sessionId);

          const lines: string[] = [];

          if (session?.title) {
            lines.push(`**Session**: ${session.title}`);
          } else {
            lines.push(`**Session**: ${sessionId}`);
          }

          if (session?.summary) {
            lines.push(`**Summary**: ${session.summary}`);
          }

          lines.push(`**Turns**: ${convo.turn_count}`);
          lines.push("");

          const turnsToShow = convo.turns.slice(0, maxTurns);

          for (const turn of turnsToShow) {
            const role = turn.role === "user" ? "👤 User" : "🤖 Assistant";

            if (turn.encrypted) {
              lines.push(`${role}: (encrypted — cannot decrypt with current key)`);
            } else if (turn.content) {
              // Truncate long content for LLM context efficiency
              const preview =
                turn.content.length > 200
                  ? turn.content.slice(0, 200) + "..."
                  : turn.content;
              lines.push(`${role}: ${preview}`);
            } else {
              lines.push(`${role}: (empty)`);
            }
          }

          if (convo.turns.length > maxTurns) {
            lines.push("");
            lines.push(`... ${convo.turns.length - maxTurns} more turns not shown.`);
          }

          log.info("[MemChain] replay executed", {
            sessionId,
            turnsShown: turnsToShow.length,
            totalTurns: convo.turn_count,
          });

          return { result: lines.join("\n") };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("[MemChain] replay failed", { error: message, sessionId });
          return { result: "Conversation replay failed. The feature requires MemChain v2.5.0+." };
        }
      },
    }),
    { names: ["memchain_replay"] },
  );
}
