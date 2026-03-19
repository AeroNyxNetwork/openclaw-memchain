/**
 * ============================================
 * File: src/tools/search-tool.ts
 * ============================================
 * Creation Reason: BM25 keyword search across all memories.
 *   Complements memchain_recall (semantic/vector search) with exact keyword matching.
 *   Better for finding specific terms: "JWT", "Redis", error codes, names.
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient.search)
 *
 * ⚠️ Important Note for Next Developer:
 *   - Requires MemChain v2.5.0+ (GET /api/mpi/search)
 *   - Snippets contain <mark> tags — stripped for LLM, kept for UI
 *   - Results are grouped by session for better context
 *   - Falls back gracefully if endpoint not available (older Rust version)
 *
 * Last Modified: v0.3.0 — Initial creation
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

interface SearchInput {
  query: string;
  limit?: number;
}

export function registerSearchTool(
  api: PluginApi,
  client: MemChainClient,
  log: PluginLogger,
): void {
  api.registerTool(
    (_ctx) => ({
      name: "memchain_search",
      description:
        "Search memories by keywords (BM25 full-text search). " +
        "Better than memchain_recall for exact terms: names, error codes, " +
        "specific technologies. Returns highlighted snippets grouped by session.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: 'Keywords to search. Examples: "JWT", "Redis error", "meeting with Alice"',
          },
          limit: {
            type: "number",
            description: "Max results to return (default: 10, max: 50)",
          },
        },
        required: ["query"],
      },
      execute: async (_toolCallId: string, input: SearchInput) => {
        const query = input.query?.trim();
        if (!query) {
          return { result: "No search query provided." };
        }

        const limit = Math.min(Math.max(input.limit || 10, 1), 50);

        try {
          const result = await client.search(query, limit);

          if (!result) {
            return { result: "Search unavailable — MemChain may not support this feature yet." };
          }

          if (result.total_results === 0) {
            return { result: `No memories found for "${query}".` };
          }

          // Format results with session grouping
          const lines: string[] = [];
          lines.push(`Found ${result.total_results} results for "${query}":`);
          lines.push("");

          for (const group of result.results) {
            const title = group.session_title || group.session_id.slice(0, 12);
            lines.push(`**${title}**`);

            for (const hit of group.hits) {
              // Strip <mark> tags for LLM, replace with **bold** for emphasis
              const clean = hit.snippet.replace(/<mark>/g, "**").replace(/<\/mark>/g, "**");
              lines.push(`  - ${clean} (score: ${hit.score.toFixed(1)})`);
            }
            lines.push("");
          }

          log.info("[MemChain] search executed", {
            query: query.slice(0, 50),
            totalResults: result.total_results,
          });

          return { result: lines.join("\n") };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("[MemChain] search failed", { error: message });
          return { result: "Search failed. The feature may require MemChain v2.5.0+." };
        }
      },
    }),
    { names: ["memchain_search"] },
  );
}
