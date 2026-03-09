/**
 * ============================================
 * File: src/tools/remember-tool.ts
 * ============================================
 * Creation Reason: Agent proactively stores memories in MemChain.
 *
 * ⚠️ CRITICAL FIX (v0.1.3):
 *   OpenClaw registerTool actual API (from memory-core source):
 *     api.registerTool(
 *       (ctx) => toolDef | toolDef[] | null,
 *       { names: ["tool_name"] }   ← names (plural), not name
 *     )
 *   ctx object has: ctx.config, ctx.sessionKey, etc.
 *   Tool def: { name, description, inputSchema, execute }
 *
 * Last Modified: v0.1.3 — Fixed registerTool to match OpenClaw API
 * ============================================
 */

import type { MemChainClient } from "../core/client.js";
import type { MemChainPluginConfig, MemoryLayer } from "../types/memchain.js";

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

interface RememberInput {
  content: string;
  layer: MemoryLayer;
  topic_tags?: string[];
}

export function registerRememberTool(
  api: PluginApi,
  client: MemChainClient,
  cfg: MemChainPluginConfig,
  log: PluginLogger,
): void {
  api.registerTool(
    (_ctx) => ({
      name: "memchain_remember",
      description:
        "Store information about the user in long-term cognitive memory (MemChain). " +
        "Use when the user shares identity info (name, job, allergies), preferences " +
        "(language, style, tools), or important events (projects, deadlines). " +
        "Content should be a third-person summary, not the user's exact words. " +
        "Deduplication is automatic.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "Third-person summary of the information to remember. " +
              'Example: "User is allergic to peanuts"',
          },
          layer: {
            type: "string",
            enum: ["identity", "knowledge", "episode"],
            description:
              "Memory layer: identity (unchanging personal info), " +
              "knowledge (preferences/skills), episode (events/tasks)",
          },
          topic_tags: {
            type: "array",
            items: { type: "string" },
            description: 'Semantic tags. Examples: ["health", "allergy"]',
          },
        },
        required: ["content", "layer"],
      },
      execute: async (input: RememberInput) => {
        const content = input.content?.trim();
        if (!content || content.length < 3) {
          return { result: "Content too short — provide a meaningful description." };
        }

        const validLayers: MemoryLayer[] = ["identity", "knowledge", "episode"];
        if (!validLayers.includes(input.layer)) {
          return { result: `Invalid layer "${input.layer}". Use: identity, knowledge, or episode.` };
        }

        try {
          let embedding: number[] = [];
          const embedResult = await client.embedSingle(content);
          if (embedResult) {
            embedding = embedResult;
          } else {
            log.warn("[MemChain] embed unavailable for remember, storing without embedding");
          }

          const result = await client.remember({
            content,
            layer: input.layer,
            topic_tags: input.topic_tags || [],
            source_ai: cfg.sourceAi,
            embedding,
            embedding_model: cfg.embeddingModel,
          });

          if (!result) {
            return { result: "Memory service temporarily unavailable. Will be captured via log." };
          }

          if (result.status === "duplicate") {
            log.info("[MemChain] duplicate memory detected", { duplicateOf: result.duplicate_of });
            return { result: `Already known (matches existing record).` };
          }

          log.info("[MemChain] memory stored", { recordId: result.record_id, layer: input.layer });
          return { result: `Remembered [${input.layer}]: ${content}` };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("[MemChain] remember tool failed", { error: message });
          return { result: "Failed to store memory. Will be captured via log." };
        }
      },
    }),
    { names: ["memchain_remember"] },
  );
}
