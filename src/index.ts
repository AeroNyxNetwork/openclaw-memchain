/**
 * ============================================
 * File: src/index.ts
 * ============================================
 * Creation Reason: Main entry point for @aeronyx/openclaw-memchain plugin.
 *   Wires together all hooks, tools, and the MemChain HTTP client.
 *
 * Main Functionality:
 *   - Export plugin definition (id, name, configSchema, register)
 *   - Initialize MemChainClient with user config
 *   - Initialize SessionStore for transient session state
 *   - Register 3 lifecycle hooks (recall, log, health)
 *   - Register 3 agent tools (remember, forget, recall)
 *
 * Dependencies:
 *   - All src/ modules
 *
 * ⚠️ Important Note for Next Developer:
 *   - register() must be synchronous (OpenClaw requirement)
 *   - All async work happens inside hook/tool handlers
 *   - Plugin kind is "memory" — OpenClaw uses for slot-based selection
 *
 * Last Modified: v0.1.0-fix1 — Fixed: correct import names, removed type-only casts
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

/* eslint-disable @typescript-eslint/no-explicit-any */
interface PluginApi {
  config(): MemChainPluginConfig;
  logger(scope: string): PluginLogger;
  on(event: string, handler: (...args: any[]) => Promise<any>, options?: { priority?: number }): void;
  registerHook(event: string, handler: (...args: any[]) => Promise<void>, options?: { name?: string; description?: string }): void;
  registerTool(factory: (ctx: any) => any, options?: { name?: string; optional?: boolean }): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Plugin Definition (default export)
// ---------------------------------------------------------------------------

export default {
  id: "aeronyx-memchain",
  name: "AeroNyx MemChain",
  description:
    "4-layer cognitive memory with MVF scoring, negative feedback learning, " +
    "and co-occurrence graph. Gives your OpenClaw agent persistent, cross-session " +
    "memory powered by the AeroNyx MemChain engine.",
  kind: "memory",
  configSchema: configSchema(),

  register(api: PluginApi): void {
    const cfg = api.config();
    const log = api.logger("memchain");

    log.info("Initializing AeroNyx MemChain plugin", {
      memchainUrl: cfg.memchainUrl,
      embeddingModel: cfg.embeddingModel,
      autoRecall: cfg.enableAutoRecall,
      autoLog: cfg.enableAutoLog,
    });

    // Initialize MemChain HTTP client
    const client = new MemChainClient({
      baseUrl: cfg.memchainUrl || "http://127.0.0.1:8421",
      embeddingModel: cfg.embeddingModel || "minilm-l6-v2",
      sourceAi: cfg.sourceAi || "openclaw-memchain",
      timeout: cfg.timeout || 5000,
      logger: log,
    });

    // Initialize session state store
    const sessions = new SessionStore();

    // Register lifecycle hooks
    registerHealthHook(api, client, log);
    registerRecallHook(api, client, sessions, cfg, log);
    registerLogHook(api, client, sessions, cfg, log);

    // Register agent tools
    registerRememberTool(api, client, cfg, log);
    registerForgetTool(api, client, log);
    registerRecallTool(api, client, cfg, log);

    log.info("AeroNyx MemChain plugin registered successfully", {
      hooks: ["recall", "log", "health"],
      tools: ["memchain_remember", "memchain_forget", "memchain_recall"],
    });
  },
};
