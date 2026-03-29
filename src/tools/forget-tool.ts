/**
 * ============================================
 * File: src/tools/forget-tool.ts
 * ============================================
 * Creation Reason: User-requested memory deletion from MemChain.
 *
 * Modification Reason (v0.3.0):
 *   BUG FIX — execute() had wrong signature: (input) instead of (_toolCallId, input).
 *   OpenClaw registerTool execute always receives two arguments:
 *     arg0: toolCallId (string) — ignored here but must be declared
 *     arg1: params      (object) — the actual tool input
 *   With the single-argument signature, `input` was receiving the toolCallId
 *   string instead of the params object, causing input.record_id to always
 *   be undefined and every forget call to return "No record_id provided."
 *   Both remember-tool.ts and recall-tool.ts already use the correct
 *   two-argument form — this file was the only outlier.
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient)
 *
 * ⚠️ Important Note for Next Developer:
 *   - execute() MUST always be (_toolCallId, params) — two args, no exceptions.
 *     Forgetting the first arg silently breaks the tool with no TypeScript error
 *     because the param type is compatible with string at runtime.
 *   - Maintain interface compatibility with client.ts: client.forget(recordId)
 *
 * Last Modified: v0.3.0 — Fixed execute() signature (_toolCallId, input)
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

interface ForgetInput {
  record_id: string;
}

export function registerForgetTool(
  api: PluginApi,
  client: MemChainClient,
  log: PluginLogger,
): void {
  api.registerTool(
    (_ctx) => ({
      name: "memchain_forget",
      description:
        "Permanently delete a specific memory from MemChain. " +
        "First use memchain_recall to find the record_id, " +
        "show it to the user for confirmation, then call this tool.",
      parameters: {
        type: "object",
        properties: {
          record_id: {
            type: "string",
            description: "The record_id of the memory to delete (from memchain_recall).",
          },
        },
        required: ["record_id"],
      },
      // v0.3.0 FIX: was execute(input) — missing first arg caused input to receive
      // the toolCallId string, making record_id always undefined.
      execute: async (_toolCallId: string, input: ForgetInput) => {
        const recordId = input.record_id?.trim();
        if (!recordId) {
          return { result: "No record_id provided. Use memchain_recall first." };
        }
        if (recordId.length < 8) {
          return { result: `Invalid record_id "${recordId}".` };
        }
        try {
          const result = await client.forget(recordId);
          if (!result) {
            return { result: "Memory service temporarily unavailable." };
          }
          if (result.status === "revoked") {
            log.info("[MemChain] memory forgotten", { recordId });
            return { result: `Memory ${recordId.slice(0, 8)}... permanently deleted.` };
          }
          if (result.status === "not_found") {
            return {
              result: `Memory ${recordId.slice(0, 8)}... not found. May already be deleted.`,
            };
          }
          return { result: `Unexpected response: ${result.status}.` };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("[MemChain] forget tool failed", { error: message, recordId });
          return { result: "Failed to delete memory. Please try again." };
        }
      },
    }),
    { names: ["memchain_forget"] },
  );
}
