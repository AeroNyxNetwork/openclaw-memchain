/**
 * ============================================
 * File: src/tools/recall-tool.ts
 * ============================================
 * Creation Reason: Allow the agent to explicitly search MemChain for specific
 *   memories. While recall-hook.ts handles automatic injection, this tool
 *   lets the agent do targeted queries — e.g., when the user asks "what do
 *   you remember about me?" or before calling memchain_forget.
 *
 * Main Functionality:
 *   - Register "memchain_recall" tool via OpenClaw Plugin SDK
 *   - Agent provides a query string → tool embeds it → calls /recall
 *   - Returns formatted list of memories with record_ids, layers, and scores
 *   - Used for: user memory inspection, pre-forget lookup, targeted recall
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient.embedSingle, .recall)
 *   - src/types/memchain.ts (MemChainPluginConfig)
 *   - OpenClaw Plugin SDK: api.registerTool()
 *
 * Main Logical Flow:
 *   1. User asks "what do you know about me?" or "what's my allergy?"
 *   2. Agent calls memchain_recall with a query string
 *   3. Tool embeds the query via /api/mpi/embed
 *   4. Tool calls /api/mpi/recall with the embedding
 *   5. Returns formatted memory list to agent
 *   6. Agent presents relevant memories to user (or uses for forget workflow)
 *
 * ⚠️ Important Note for Next Developer:
 *   - This is SEPARATE from the automatic recall in recall-hook.ts
 *   - recall-hook injects into system prompt silently
 *   - This tool returns results to the agent as tool output (visible in reasoning)
 *   - Both use the same MemChain /recall endpoint
 *   - record_ids in the output are needed for the memchain_forget workflow
 *
 * Last Modified: v0.1.0 - Initial creation
 * ============================================
 */

import type { MemChainClient } from "../core/client.js";
import type { MemChainPluginConfig, Memory } from "../types/memchain.js";

/** Minimal logger interface */
interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
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
  execute: (input: RecallInput) => Promise<ToolResult>;
}

interface ToolResult {
  result: string;
}

/** Input schema for the recall tool */
interface RecallInput {
  query: string;
  top_k?: number;
}

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

/**
 * Register the memchain_recall tool with OpenClaw.
 *
 * @param api    - OpenClaw Plugin API
 * @param client - MemChain HTTP client
 * @param cfg    - Plugin configuration
 * @param log    - Plugin logger
 */
export function registerRecallTool(
  api: PluginApi,
  client: MemChainClient,
  cfg: MemChainPluginConfig,
  log: PluginLogger,
): void {
  api.registerTool(
    (_ctx: ToolContext) => ({
      name: "memchain_recall",
      description:
        "Search MemChain for memories about the user. Use when the user asks " +
        '"what do you know about me?" or when you need to find a specific memory ' +
        "(e.g., before calling memchain_forget). Returns memories with record_ids, " +
        "layers, scores, and content.",

      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query — describe what you're looking for. " +
              'Examples: "user allergies", "programming preferences", "recent projects"',
          },
          top_k: {
            type: "number",
            description: "Maximum number of memories to return (default: 10, max: 50)",
          },
        },
        required: ["query"],
      },

      execute: async (input: RecallInput): Promise<ToolResult> => {
        const query = input.query?.trim();
        if (!query) {
          return { result: "No query provided. Describe what memories you want to find." };
        }

        const topK = Math.min(Math.max(input.top_k || cfg.recallTopK, 1), 50);

        try {
          // Step 1: Embed the query
          const embedding = await client.embedSingle(query);
          if (!embedding) {
            return {
              result: "Memory search unavailable — embedding service not responding.",
            };
          }

          // Step 2: Recall from MemChain
          const result = await client.recall({
            embedding,
            embedding_model: cfg.embeddingModel,
            top_k: topK,
            token_budget: cfg.tokenBudget,
          });

          if (!result) {
            return {
              result: "Memory search unavailable — MemChain not responding.",
            };
          }

          if (!result.memories.length) {
            return {
              result: "No memories found matching that query.",
            };
          }

          // Step 3: Format results for agent consumption
          const formatted = formatRecallResults(result.memories, result.total_candidates);

          log.debug("Manual recall", {
            query: query.slice(0, 50),
            returned: result.memories.length,
            candidates: result.total_candidates,
          });

          return { result: formatted };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("Recall tool failed", { error: message, query: query.slice(0, 50) });
          return { result: "Memory search failed. Please try again." };
        }
      },
    }),
    { name: "memchain", optional: true },
  );
}

// ---------------------------------------------------------------------------
// Result Formatting
// ---------------------------------------------------------------------------

/**
 * Format recall results for agent tool output.
 * Includes record_ids so the agent can use them with memchain_forget.
 *
 * Output format:
 * ```
 * Found 5 memories (from 12 candidates):
 *
 * 1. [identity] My name is Alice
 *    ID: 557014a3  Score: 1.30  Tags: name
 *
 * 2. [knowledge] User prefers dark mode
 *    ID: da762b97  Score: 0.85  Tags: preference, ui
 * ```
 */
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
