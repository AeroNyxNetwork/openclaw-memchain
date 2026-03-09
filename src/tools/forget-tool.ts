/**
 * ============================================
 * File: src/tools/forget-tool.ts
 * ============================================
 * Creation Reason: User-requested memory deletion from MemChain.
 *
 * Last Modified: v0.1.3 — Fixed registerTool to match OpenClaw API (names plural)
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
      execute: async (input: ForgetInput) => {
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
            return { result: `Memory ${recordId.slice(0, 8)}... not found. May already be deleted.` };
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
