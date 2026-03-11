/**
 * ============================================
 * File: src/config.ts
 * ============================================
 * Creation Reason: Define the JSON Schema for plugin configuration.
 *
 * v0.2.0 Changes:
 *   - Added "mode" field: "local" (default) or "remote"
 *   - Added "nodeUrl" field: remote MemChain node URL
 *   - Added "keyStorePath" field: Ed25519 key file location
 *   - Local mode: Bearer token + localhost (unchanged)
 *   - Remote mode: Ed25519 signature + E2E encryption
 *
 * Dependencies:
 *   - Referenced by: src/index.ts (plugin entry)
 *   - Type mirror: src/types/memchain.ts → MemChainPluginConfig
 *
 * ⚠️ Important Note for Next Developer:
 *   - Property names must match MemChainPluginConfig interface
 *   - "mode" defaults to "local" — all existing behavior unchanged
 *   - "nodeUrl" is only used in remote mode
 *   - "keyStorePath" defaults to ~/.openclaw/memchain-keys.json
 *
 * Last Modified: v0.2.0 - Added remote mode configuration fields
 * ============================================
 */

export function configSchema() {
  return {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      mode: {
        type: "string",
        enum: ["local", "remote"],
        default: "local",
        description:
          "Operating mode. 'local' uses Bearer token auth with localhost MemChain. " +
          "'remote' uses Ed25519 signature auth with end-to-end encryption against a remote node.",
      },
      memchainUrl: {
        type: "string",
        default: "http://127.0.0.1:8421",
        description:
          "MemChain MPI endpoint URL for local mode. Ignored in remote mode (use nodeUrl instead).",
      },
      nodeUrl: {
        type: "string",
        default: "",
        description:
          "Remote MemChain node URL. Only used in remote mode. " +
          "Example: 'http://node-ip:8421' or 'wss://node.example.com/memchain'.",
      },
      keyStorePath: {
        type: "string",
        default: "~/.openclaw/memchain-keys.json",
        description:
          "Path to Ed25519 key pair file. Auto-generated on first remote mode startup. " +
          "File permissions are set to 600 (owner-only read/write).",
      },
      embeddingModel: {
        type: "string",
        default: "minilm-l6-v2",
        description:
          "Embedding model identifier. Must match the model configured in MemChain server.",
      },
      sourceAi: {
        type: "string",
        default: "openclaw-memchain",
        description:
          "Source identifier sent with remember/log calls.",
      },
      tokenBudget: {
        type: "number",
        default: 2000,
        minimum: 100,
        maximum: 8000,
        description:
          "Maximum token budget for recall context injection into system prompt.",
      },
      recallTopK: {
        type: "number",
        default: 10,
        minimum: 1,
        maximum: 50,
        description:
          "Maximum number of memories to recall per turn.",
      },
      timeout: {
        type: "number",
        default: 5000,
        minimum: 1000,
        maximum: 30000,
        description:
          "HTTP request timeout in milliseconds.",
      },
      enableAutoRecall: {
        type: "boolean",
        default: true,
        description:
          "Automatically recall memories before every LLM prompt.",
      },
      enableAutoLog: {
        type: "boolean",
        default: true,
        description:
          "Automatically log conversation turns on session end. " +
          "Note: In remote mode, /log is disabled (403). Memory extraction relies on agent calling memchain_remember.",
      },
    },
  };
}
