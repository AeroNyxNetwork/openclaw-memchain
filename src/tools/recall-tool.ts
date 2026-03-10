/**
 * ============================================
 * File: src/tools/recall-tool.ts
 * ============================================
 * Creation Reason: Agent explicitly searches MemChain for memories.
 *
 * Last Modified: v0.1.3 — Fixed registerTool to match OpenClaw API (names plural)
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
          });

          if (!result) {
            return { result: "Memory search unavailable — MemChain not responding." };
          }

          if (!result.memories.length) {
            return { result: "No memories found matching that query." };
          }

          const formatted = formatRecallResults(result.memories, result.total_candidates);

          log.warn("[MemChain] manual recall executed", {
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
