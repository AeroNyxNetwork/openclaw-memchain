/**
 * ============================================
 * File: src/tools/forget-tool.ts
 * ============================================
 * Creation Reason: Allow the user to explicitly request deletion of specific
 *   memories from MemChain. This is a privacy/data-sovereignty feature —
 *   the user has full control over what the AI remembers.
 *
 * Main Functionality:
 *   - Register "memchain_forget" tool via OpenClaw Plugin SDK
 *   - Agent calls this when user says "forget X" or "delete that memory"
 *   - Calls MemChain /api/mpi/forget for cryptographic-level erasure
 *   - Content is permanently destroyed — cannot be recovered
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient.forget)
 *   - OpenClaw Plugin SDK: api.registerTool()
 *
 * Main Logical Flow:
 *   1. User says "forget that I'm allergic to peanuts"
 *   2. Agent should FIRST use memchain_recall to find the record_id
 *   3. Agent confirms with user: "I found this memory: '...' — delete it?"
 *   4. User confirms → agent calls memchain_forget with record_id
 *   5. MemChain revokes the record (content erasure + status="revoked")
 *   6. Memory will no longer appear in future recall results
 *
 * ⚠️ Important Note for Next Developer:
 *   - ALWAYS require user confirmation before forgetting (SKILL.md enforces this)
 *   - record_id must come from a prior memchain_recall — agent should not guess
 *   - Forget is permanent — MemChain uses cryptographic erasure
 *   - If the record doesn't exist, MemChain returns "not_found" — handle gracefully
 *
 * Last Modified: v0.1.0 - Initial creation
 * ============================================
 */

import type { MemChainClient } from "../core/client.js";

/** Minimal logger interface */
interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** Tool context from OpenClaw SDK */
interface ToolContext {
  senderId?: string;
}

/** Minimal Plugin API */
interface PluginApi {
  registerTool(
    factory: (ctx: ToolContext) => ToolDefinition,
    options?: { name?: string; optional?: boolean },
  ): void;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: ForgetInput) => Promise<ToolResult>;
}

interface ToolResult {
  result: string;
}

/** Input schema for the forget tool */
interface ForgetInput {
  record_id: string;
}

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

/**
 * Register the memchain_forget tool with OpenClaw.
 *
 * @param api    - OpenClaw Plugin API
 * @param client - MemChain HTTP client
 * @param log    - Plugin logger
 */
export function registerForgetTool(
  api: PluginApi,
  client: MemChainClient,
  log: PluginLogger,
): void {
  api.registerTool(
    (_ctx: ToolContext) => ({
      name: "memchain_forget",
      description:
        "Permanently delete a specific memory from MemChain. " +
        "IMPORTANT: First use memchain_recall to find the record_id of the memory " +
        "to delete, show it to the user for confirmation, then call this tool. " +
        "Deletion is permanent and cannot be undone.",

      inputSchema: {
        type: "object",
        properties: {
          record_id: {
            type: "string",
            description:
              "The record_id of the memory to delete. " +
              "Obtain this from a prior memchain_recall result.",
          },
        },
        required: ["record_id"],
      },

      execute: async (input: ForgetInput): Promise<ToolResult> => {
        // Validate record_id format
        const recordId = input.record_id?.trim();
        if (!recordId) {
          return {
            result: "No record_id provided. Use memchain_recall first to find the memory to delete.",
          };
        }

        // Basic format validation (MemChain record IDs are hex strings)
        if (recordId.length < 8) {
          return {
            result: `Invalid record_id "${recordId}". Record IDs are hex strings from memchain_recall results.`,
          };
        }

        try {
          const result = await client.forget(recordId);

          if (!result) {
            return {
              result: "Memory service temporarily unavailable. Please try again later.",
            };
          }

          if (result.status === "revoked") {
            log.info("Memory forgotten", { recordId });
            return {
              result: `Memory ${recordId.slice(0, 8)}... has been permanently deleted. It will no longer appear in future conversations.`,
            };
          }

          if (result.status === "not_found") {
            log.info("Forget target not found", { recordId });
            return {
              result: `Memory ${recordId.slice(0, 8)}... was not found. It may have already been deleted.`,
            };
          }

          // Unexpected status
          return {
            result: `Unexpected response: ${result.status}. The memory may or may not have been deleted.`,
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("Forget tool failed", { error: message, recordId });
          return {
            result: "Failed to delete memory. Please try again later.",
          };
        }
      },
    }),
    { name: "memchain", optional: true },
  );
}
