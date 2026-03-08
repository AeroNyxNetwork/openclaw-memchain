/**
 * ============================================
 * File: src/index.ts
 * ============================================
 * Creation Reason: Main entry point for the @aeronyx/openclaw-memchain plugin.
 *   This file implements the OpenClawPluginDefinition interface and wires
 *   together all hooks, tools, and the MemChain HTTP client.
 *
 * Main Functionality:
 *   - Export the plugin definition (id, name, configSchema, register)
 *   - Initialize MemChainClient with user config
 *   - Initialize SessionStore for transient session state
 *   - Register 3 lifecycle hooks (recall, log, health)
 *   - Register 3 agent tools (remember, forget, recall)
 *
 * Dependencies:
 *   - src/config.ts (configSchema)
 *   - src/core/client.ts (MemChainClient)
 *   - src/core/session-store.ts (SessionStore)
 *   - src/hooks/recall-hook.ts (registerRecallHook)
 *   - src/hooks/log-hook.ts (registerLogHook)
 *   - src/hooks/health-hook.ts (registerHealthHook)
 *   - src/tools/remember-tool.ts (registerRememberTool)
 *   - src/tools/forget-tool.ts (registerForgetTool)
 *   - src/tools/recall-tool.ts (registerRecallTool)
 *   - OpenClaw Plugin SDK: OpenClawPluginApi
 *
 * Main Logical Flow:
 *   1. OpenClaw discovers this plugin via package.json "main" field
 *   2. Calls default export's register(api) with the Plugin API
 *   3. We read user config via api.config()
 *   4. Initialize MemChainClient (HTTP client to localhost:8421)
 *   5. Initialize SessionStore (in-memory session tracking)
 *   6. Register all hooks and tools
 *   7. Plugin is active — hooks fire on every conversation
 *
 * ⚠️ Important Note for Next Developer:
 *   - The register() function must be synchronous (OpenClaw requirement)
 *   - All async work happens inside hook/tool handlers, not during registration
 *   - If MemChain is unreachable, everything degrades gracefully (no crashes)
 *   - The SessionStore is NOT persisted — it's intentionally transient
 *   - Plugin kind is "memory" — OpenClaw may use this for slot-based selection
 *
 * Last Modified: v0.1.0 - Initial creation
 * ============================================
 */

import { configSchema } from "./config.js";
import { MemChainClient } from "./core/client.js";
import { SessionStore } from "./core/session-store.js";
import { registerRecallHook } from "./hooks/recall-hook.js";
import { registerLogHook } from "./hooks/log-hook.js";
import { registerHealthHook } from "./hooks/health-hook.js";
import { registerRememberTool } from "./tools/remember-tool.js";
import { registerForgetTool } from "./tools/forget-tool.js";
import { registerRecallTool } from "./tools/recall-tool.js";
import type { MemChainPluginConfig } from "./types/memchain.js";

// ---------------------------------------------------------------------------
// Plugin API type (minimal interface matching OpenClaw Plugin SDK)
// ---------------------------------------------------------------------------

interface PluginApi {
  /** Get resolved plugin configuration (user overrides merged with defaults) */
  config(): MemChainPluginConfig;
  /** Get a scoped logger instance */
  logger(scope: string): PluginLogger;
  /** Register a typed lifecycle hook */
  on(
    event: string,
    handler: (event: unknown, ctx: unknown) => Promise<unknown>,
    options?: { priority?: number },
  ): void;
  /** Register an event-driven hook */
  registerHook(
    event: string,
    handler: (event: unknown) => Promise<void>,
    options?: { name?: string; description?: string },
  ): void;
  /** Register an agent tool */
  registerTool(
    factory: (ctx: unknown) => unknown,
    options?: { name?: string; optional?: boolean },
  ): void;
}

interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Plugin Definition (default export)
// ---------------------------------------------------------------------------

/**
 * @aeronyx/openclaw-memchain plugin definition.
 *
 * This is the default export consumed by OpenClaw's plugin loader.
 * It follows the OpenClawPluginDefinition contract:
 *   - id: unique plugin identifier
 *   - name: human-readable name
 *   - description: shown in plugin list and Control UI
 *   - kind: plugin category ("memory" for memory-related plugins)
 *   - configSchema: JSON Schema for user configuration
 *   - register: called once with the Plugin API to set up hooks and tools
 */
export default {
  id: "aeronyx-memchain",
  name: "AeroNyx MemChain",
  description:
    "4-layer cognitive memory with MVF scoring, negative feedback learning, " +
    "and co-occurrence graph. Gives your OpenClaw agent persistent, cross-session " +
    "memory powered by the AeroNyx MemChain engine.",
  kind: "memory",
  configSchema: configSchema(),

  /**
   * Register all plugin components with OpenClaw.
   *
   * This function is called ONCE during gateway startup.
   * It must be synchronous — all async work happens in hook handlers.
   *
   * @param api - OpenClaw Plugin API providing config, logger, and registration methods
   */
  register(api: PluginApi): void {
    // -----------------------------------------------------------------
    // Step 1: Read user configuration (merged with defaults from configSchema)
    // -----------------------------------------------------------------
    const cfg = api.config();
    const log = api.logger("memchain");

    log.info("Initializing AeroNyx MemChain plugin", {
      memchainUrl: cfg.memchainUrl,
      embeddingModel: cfg.embeddingModel,
      autoRecall: cfg.enableAutoRecall,
      autoLog: cfg.enableAutoLog,
      tokenBudget: cfg.tokenBudget,
      recallTopK: cfg.recallTopK,
    });

    // -----------------------------------------------------------------
    // Step 2: Initialize MemChain HTTP client
    // All hooks and tools share this single client instance.
    // The client handles timeouts and returns null on failure.
    // -----------------------------------------------------------------
    const client = new MemChainClient({
      baseUrl: cfg.memchainUrl || "http://127.0.0.1:8421",
      embeddingModel: cfg.embeddingModel || "minilm-l6-v2",
      sourceAi: cfg.sourceAi || "openclaw-memchain",
      timeout: cfg.timeout || 5000,
      logger: log,
    });

    // -----------------------------------------------------------------
    // Step 3: Initialize session state store
    // Tracks conversation turns and recall context in memory.
    // Automatically evicts stale sessions (4h TTL).
    // -----------------------------------------------------------------
    const sessions = new SessionStore();

    // -----------------------------------------------------------------
    // Step 4: Register lifecycle hooks
    //
    // Execution order during a typical conversation:
    //   gateway start  → health-hook (once)
    //   user message    → recall-hook (every turn, before LLM)
    //   message arrives → log-hook collector (every message)
    //   session ends    → log-hook flusher (once per session)
    // -----------------------------------------------------------------

    // Health check: verify MemChain is reachable on first session
    registerHealthHook(
      api as Parameters<typeof registerHealthHook>[0],
      client,
      log,
    );

    // Core recall: embed user message → recall memories → inject system prompt
    registerRecallHook(
      api as Parameters<typeof registerRecallHook>[0],
      client,
      sessions,
      cfg,
      log,
    );

    // Conversation logging: collect turns → flush to /log on session end
    registerLogHook(
      api as Parameters<typeof registerLogHook>[0],
      client,
      sessions,
      cfg,
      log,
    );

    // -----------------------------------------------------------------
    // Step 5: Register agent tools
    //
    // These are optional tools the agent can call during conversation:
    //   memchain_remember — proactively store user info
    //   memchain_forget   — delete a memory (user-requested)
    //   memchain_recall   — explicit memory search
    // -----------------------------------------------------------------

    // Remember: agent stores user info with layer + tags
    registerRememberTool(
      api as Parameters<typeof registerRememberTool>[0],
      client,
      cfg,
      log,
    );

    // Forget: agent deletes a memory by record_id
    registerForgetTool(
      api as Parameters<typeof registerForgetTool>[0],
      client,
      log,
    );

    // Recall: agent explicitly searches memories (for inspection or pre-forget)
    registerRecallTool(
      api as Parameters<typeof registerRecallTool>[0],
      client,
      cfg,
      log,
    );

    // -----------------------------------------------------------------
    // Done
    // -----------------------------------------------------------------
    log.info("AeroNyx MemChain plugin registered successfully", {
      hooks: ["recall", "log", "health"],
      tools: ["memchain_remember", "memchain_forget", "memchain_recall"],
    });
  },
};
