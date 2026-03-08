/**
 * ============================================
 * File: src/tools/remember-tool.ts
 * ============================================
 * Creation Reason: Give the OpenClaw agent the ability to proactively store
 *   memories in MemChain. While /log auto-extracts information, agent-driven
 *   remember is faster (immediate embedding) and more accurate (agent judges
 *   the correct layer and tags).
 *
 * Main Functionality:
 *   - Register "memchain_remember" tool via OpenClaw Plugin SDK
 *   - Agent calls this when user shares identity, preferences, or facts
 *   - Embeds content via /api/mpi/embed, then stores via /api/mpi/remember
 *   - Returns confirmation or dedup notice to the agent
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient.embedSingle, .remember)
 *   - src/types/memchain.ts (MemChainPluginConfig, MemoryLayer)
 *   - OpenClaw Plugin SDK: api.registerTool()
 *
 * Main Logical Flow:
 *   1. Agent decides user said something worth remembering
 *   2. Agent calls memchain_remember with content, layer, topic_tags
 *   3. Tool embeds the content via MemChain /embed
 *   4. Tool stores via MemChain /remember (with embedding + layer + tags)
 *   5. MemChain dedup checks (cos > threshold per layer)
 *   6. Return "created" or "duplicate" to agent
 *
 * ⚠️ Important Note for Next Developer:
 *   - Content MUST be third-person summary, not user's exact words
 *     (the SKILL.md instructs the agent on this)
 *   - Embedding model must match recall-time model — config.embeddingModel
 *   - If embed fails, we still try to remember without embedding —
 *     Miner will backfill the embedding later (Step 0.5)
 *   - Tool is registered as optional (won't break if MemChain is down)
 *
 * Last Modified: v0.1.0 - Initial creation
 * ============================================
 */

import type { MemChainClient } from "../core/client.js";
import type { MemChainPluginConfig, MemoryLayer } from "../types/memchain.js";

/** Minimal logger interface */
interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** Tool registration context from OpenClaw SDK */
interface ToolContext {
  senderId?: string;
}

/** Minimal Plugin API for tool registration */
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
  execute: (input: RememberInput) => Promise<ToolResult>;
}

interface ToolResult {
  result: string;
}

/** Input schema for the remember tool */
interface RememberInput {
  content: string;
  layer: MemoryLayer;
  topic_tags?: string[];
}

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

/**
 * Register the memchain_remember tool with OpenClaw.
 *
 * The agent uses this tool when it identifies user information worth
 * storing long-term. The SKILL.md provides guidance on when and how
 * to use this tool.
 *
 * @param api    - OpenClaw Plugin API
 * @param client - MemChain HTTP client
 * @param cfg    - Plugin configuration
 * @param log    - Plugin logger
 */
export function registerRememberTool(
  api: PluginApi,
  client: MemChainClient,
  cfg: MemChainPluginConfig,
  log: PluginLogger,
): void {
  api.registerTool(
    (_ctx: ToolContext) => ({
      name: "memchain_remember",
      description:
        "Store information about the user in long-term cognitive memory (MemChain). " +
        "Use when the user shares identity info (name, job, allergies), preferences " +
        "(language, style, tools), or important events (projects, deadlines). " +
        "Content should be a third-person summary, not the user's exact words. " +
        "Deduplication is automatic — safe to call even if the info might already exist.",

      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "Third-person summary of the information to remember. " +
              'Example: "User is allergic to peanuts" (not "I am allergic to peanuts")',
          },
          layer: {
            type: "string",
            enum: ["identity", "knowledge", "episode"],
            description:
              "Memory layer: " +
              '"identity" for unchanging personal info (name, allergies, family), ' +
              '"knowledge" for preferences and skills (coding style, favorite tools), ' +
              '"episode" for events and tasks (current project, today\'s meeting)',
          },
          topic_tags: {
            type: "array",
            items: { type: "string" },
            description:
              'Semantic tags for categorization. Examples: ["health", "allergy"], ' +
              '["preference", "language"], ["work", "project"]',
          },
        },
        required: ["content", "layer"],
      },

      execute: async (input: RememberInput): Promise<ToolResult> => {
        // Validate content is not empty or too short
        const content = input.content?.trim();
        if (!content || content.length < 3) {
          return { result: "Content too short — provide a meaningful description." };
        }

        // Validate layer
        const validLayers: MemoryLayer[] = ["identity", "knowledge", "episode"];
        if (!validLayers.includes(input.layer)) {
          return { result: `Invalid layer "${input.layer}". Use: identity, knowledge, or episode.` };
        }

        try {
          // Step 1: Generate embedding for the content
          // If embed fails, proceed with empty embedding — Miner Step 0.5
          // will backfill it later (async, non-blocking)
          let embedding: number[] = [];
          const embedResult = await client.embedSingle(content);
          if (embedResult) {
            embedding = embedResult;
          } else {
            log.warn("Embed unavailable for remember, storing without embedding", {
              content: content.slice(0, 50),
            });
          }

          // Step 2: Store in MemChain
          const result = await client.remember({
            content,
            layer: input.layer,
            topic_tags: input.topic_tags || [],
            source_ai: cfg.sourceAi,
            embedding,
            embedding_model: cfg.embeddingModel,
          });

          if (!result) {
            return {
              result: "Memory service temporarily unavailable. The information will be captured via conversation log.",
            };
          }

          // Step 3: Report result to agent
          if (result.status === "duplicate") {
            log.info("Duplicate memory detected", {
              duplicateOf: result.duplicate_of,
              layer: input.layer,
            });
            return {
              result: `Already known (matches existing memory ${result.duplicate_of?.slice(0, 8)}...). No action needed.`,
            };
          }

          log.info("Memory stored", {
            recordId: result.record_id,
            layer: input.layer,
            tags: input.topic_tags,
            hasEmbedding: embedding.length > 0,
          });

          return {
            result: `Remembered [${input.layer}]: ${content}`,
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("Remember tool failed", { error: message });
          return {
            result: "Failed to store memory. The information will be captured via conversation log.",
          };
        }
      },
    }),
    { name: "memchain", optional: true },
  );
}
