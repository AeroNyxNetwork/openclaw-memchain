/**
 * ============================================
 * File: src/index.ts
 * ============================================
 * Creation Reason: Main entry point for @aeronyx/openclaw-memchain plugin.
 *
 * ⚠️ CRITICAL FIX (v0.1.0-fix2):
 *   - api.config is a PROPERTY (the full openclaw config object), not a function
 *   - Plugin config lives at api.config.plugins.entries["aeronyx-memchain"].config
 *   - api.logger() IS a function
 *   - Plugin can be exported as object with register() or as a function
 *
 * Last Modified: v0.1.0-fix2 — Fixed api.config access pattern
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
// Default config values (used when user hasn't set them)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: MemChainPluginConfig = {
  memchainUrl: "http://127.0.0.1:8421",
  embeddingModel: "minilm-l6-v2",
  sourceAi: "openclaw-memchain",
  tokenBudget: 2000,
  recallTopK: 10,
  timeout: 5000,
  enableAutoRecall: true,
  enableAutoLog: true,
};

// ---------------------------------------------------------------------------
// Plugin API type (minimal interface matching OpenClaw Plugin SDK)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
interface PluginApi {
  /**
   * api.config is the FULL openclaw config object (NOT a function).
   * Plugin-specific config is at: api.config.plugins?.entries?.["aeronyx-memchain"]?.config
   */
  config: Record<string, any>;

  /** api.logger() IS a function — returns a scoped logger */
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
// Helper: Extract plugin config from the full openclaw config
// ---------------------------------------------------------------------------

function extractPluginConfig(apiConfig: Record<string, unknown>): MemChainPluginConfig {
  try {
    // Navigate: config.plugins.entries["aeronyx-memchain"].config
    const plugins = apiConfig?.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;
    const pluginEntry = entries?.["aeronyx-memchain"] as Record<string, unknown> | undefined;
    const userConfig = pluginEntry?.config as Partial<MemChainPluginConfig> | undefined;

    if (userConfig && typeof userConfig === "object") {
      return { ...DEFAULT_CONFIG, ...userConfig };
    }
  } catch {
    // If anything fails, use defaults
  }

  return { ...DEFAULT_CONFIG };
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
    const log = api.logger("memchain");

    // Extract plugin config from the full openclaw config object
    const cfg = extractPluginConfig(api.config);

    log.info("Initializing AeroNyx MemChain plugin", {
      memchainUrl: cfg.memchainUrl,
      embeddingModel: cfg.embeddingModel,
      autoRecall: cfg.enableAutoRecall,
      autoLog: cfg.enableAutoLog,
    });

    // Initialize MemChain HTTP client
    const client = new MemChainClient({
      baseUrl: cfg.memchainUrl,
      embeddingModel: cfg.embeddingModel,
      sourceAi: cfg.sourceAi,
      timeout: cfg.timeout,
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
