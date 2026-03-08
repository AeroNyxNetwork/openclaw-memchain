/**
 * ============================================
 * File: src/config.ts
 * ============================================
 * Creation Reason: Define the JSON Schema for plugin configuration.
 *   OpenClaw's Plugin SDK uses JSON Schema to render config forms in the
 *   Control UI and validate user-provided settings.
 *
 * Main Functionality:
 *   - Exports configSchema() for OpenClawPluginDefinition.configSchema
 *   - Defines all user-configurable fields with defaults and descriptions
 *   - Defaults are tuned for local deployment (127.0.0.1:8421)
 *
 * Dependencies:
 *   - Referenced by: src/index.ts (plugin entry)
 *   - Type mirror: src/types/memchain.ts → MemChainPluginConfig
 *
 * Main Logical Flow:
 *   1. OpenClaw reads this schema at plugin registration
 *   2. Control UI renders form fields based on properties
 *   3. User overrides are merged with defaults
 *   4. Final config is passed to register() via api.config()
 *
 * ⚠️ Important Note for Next Developer:
 *   - Property names must match MemChainPluginConfig interface exactly
 *   - Defaults here must stay in sync with client.ts fallback values
 *   - Do NOT add non-serializable types (functions, classes)
 *
 * Last Modified: v0.1.0 - Initial creation
 * ============================================
 */

/**
 * Returns the JSON Schema for plugin configuration.
 * Called once during plugin registration.
 *
 * OpenClaw merges user-provided config with these defaults,
 * so every field must have a sensible default value.
 */
export function configSchema() {
  return {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      memchainUrl: {
        type: "string",
        default: "http://127.0.0.1:8421",
        description:
          "MemChain MPI endpoint URL. Change this if MemChain runs on a different host or port.",
      },
      embeddingModel: {
        type: "string",
        default: "minilm-l6-v2",
        description:
          "Embedding model identifier. Must match the model configured in MemChain server. " +
          "Changing this without re-embedding existing memories will break recall.",
      },
      sourceAi: {
        type: "string",
        default: "openclaw-memchain",
        description:
          "Source identifier sent with remember/log calls. " +
          "Useful for distinguishing memories created by different AI frontends.",
      },
      tokenBudget: {
        type: "number",
        default: 2000,
        minimum: 100,
        maximum: 8000,
        description:
          "Maximum token budget for recall context injection into system prompt. " +
          "Higher values give more context but consume more of the model's context window. " +
          "2000 is recommended for most models.",
      },
      recallTopK: {
        type: "number",
        default: 10,
        minimum: 1,
        maximum: 50,
        description:
          "Maximum number of memories to recall per turn. " +
          "Identity memories are always included regardless of this limit.",
      },
      timeout: {
        type: "number",
        default: 5000,
        minimum: 1000,
        maximum: 30000,
        description:
          "HTTP request timeout in milliseconds for all MemChain API calls. " +
          "If MemChain does not respond within this time, the call is skipped gracefully.",
      },
      enableAutoRecall: {
        type: "boolean",
        default: true,
        description:
          "Automatically recall memories before every LLM prompt. " +
          "Disable this if you want manual-only recall via the memchain_recall tool.",
      },
      enableAutoLog: {
        type: "boolean",
        default: true,
        description:
          "Automatically log conversation turns to MemChain on session end. " +
          "The /log rule engine will auto-extract identities, preferences, and allergies. " +
          "Disable this only if you handle logging externally.",
      },
    },
  };
}
