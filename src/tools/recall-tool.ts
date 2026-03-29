/**
 * ============================================
 * File: src/tools/recall-tool.ts
 * ============================================
 * Creation Reason: Agent explicitly searches MemChain for memories.
 *
 * Modification Reason (v0.3.0):
 *   BUG FIX 1 — client.recall() was called without the query field.
 *   RecallRequest.query (added in v0.3.0) enables server-side hybrid
 *   retrieval and progressive retrieval mode=index preview generation.
 *   Same fix applied to recall-hook.ts in the same release.
 *
 *   BUG FIX 2 — Successful manual recall was logged at log.warn level.
 *   A user explicitly calling memchain_recall is a normal, expected event,
 *   not a warning condition. Changed to log.info.
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient)
 *   - src/types/memchain.ts (MemChainPluginConfig, Memory)
 *
 * ⚠️ Important Note for Next Developer:
 *   - Always pass query to client.recall() — omitting it degrades server-side
 *     hybrid retrieval quality even when an embedding is provided.
 *   - log.warn is for degraded/error paths only. Successful tool execution
 *     should use log.info.
 *   - Maintain interface compatibility with client.ts: client.recall(RecallRequest)
 *
 * Last Modified: v0.3.0 — Added query to recall(), fixed log level warn→info
 * ============================================
 */

import type { MemChainClient } from "../core/client.js";
import type { MemChainPluginConfig, Memory } from "../types/memchain.js";

interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface PluginApi {
  registerTool(
    factory: (ctx: any) => any | any[] | null,
    options: { names: string[] },
  ): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface RecallInput {
  query: string;
  top_k?: number;
}

export function registerRecallTool(
  api: PluginApi,
  client: MemChainClient,
  cfg: MemChainPluginConfig,
  log: PluginLogger,
): void {
  api.registerTool(
    (_ctx) => ({
      name: "memchain_recall",
      description:
        "Search MemChain for memories about the user. Use when the user asks " +
        '"what do you know about me?" or before calling memchain_forget.',
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: 'Search query. Examples: "user allergies", "programming preferences"',
          },
          top_k: {
            type: "number",
            description: "Max memories to return (default: 10, max: 50)",
          },
        },
        required: ["query"],
      },
      execute: async (_toolCallId: string, input: RecallInput) => {
        const query = input.query?.trim();
        if (!query) {
          return { result: "No query provided." };
        }
        const topK = Math.min(Math.max(input.top_k || cfg.recallTopK, 1), 50);
        try {
          const embedding = await client.embedSingle(query);
          if (!embedding) {
            return { result: "Memory search unavailable — embedding service not responding." };
          }
          const result = await client.recall({
            embedding,
            embedding_model: cfg.embeddingModel,
            top_k: topK,
            token_budget: cfg.tokenBudget,
            // v0.3.0 FIX: was missing — server needs query for hybrid retrieval
            query,
          });
          if (!result) {
            return { result: "Memory search unavailable — MemChain not responding." };
          }
          if (!result.memories.length) {
            return { result: "No memories found matching that query." };
          }
          const formatted = formatRecallResults(result.memories, result.total_candidates);
          // v0.3.0 FIX: was log.warn — manual recall is a normal event, not a warning
          log.info("[MemChain] manual recall executed", {
            query: query.slice(0, 50),
            returned: result.memories.length,
            candidates: result.total_candidates,
          });
          return { result: formatted };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("[MemChain] recall tool failed", { error: message });
          return { result: "Memory search failed. Please try again." };
        }
      },
    }),
    { names: ["memchain_recall"] },
  );
}

function formatRecallResults(memories: Memory[], totalCandidates: number): string {
  const lines: string[] = [];
  lines.push(`Found ${memories.length} memories (from ${totalCandidates} candidates):`);
  lines.push("");
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    const tags = m.topic_tags?.length ? m.topic_tags.join(", ") : "none";
    const shortId = m.record_id.slice(0, 8);
    const score = m.score.toFixed(2);
    lines.push(`${i + 1}. [${m.layer}] ${m.content}`);
    lines.push(`   ID: ${shortId}  Score: ${score}  Tags: ${tags}`);
    lines.push("");
  }
  return lines.join("\n");
}
