/**
 * ============================================
 * File: src/index.ts
 * ============================================
 * Creation Reason: Main entry point for @aeronyx/openclaw-memchain plugin.
 *
 * ⚠️ CRITICAL FIX (v0.1.0-fix3):
 *   Actual OpenClaw Plugin API shape (from debug probe):
 *     api.config        → object (full openclaw config)
 *     api.pluginConfig  → object (THIS plugin's config from entries.<id>.config)
 *     api.logger        → object (logger instance, NOT a function)
 *     api.on            → function (typed lifecycle hooks)
 *     api.registerHook  → function (event hooks)
 *     api.registerTool  → function (agent tools)
 *     api.registerHttpRoute → function
 *     api.registerChannel   → function
 *     api.registerProvider  → function
 *     api.registerContextEngine → function
 *     api.registerService   → function
 *     api.registerCommand   → function
 *     api.registerCli       → function
 *     api.registerGatewayMethod → function
 *     api.runtime       → object
 *     api.resolvePath   → function
 *     api.id            → string
 *     api.name          → string
 *     api.version       → string
 *
 * Last Modified: v0.1.0-fix3 — api.logger is object, api.pluginConfig for config
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
// Default config values
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
// Plugin API type (actual shape from OpenClaw 2026.3.7 debug probe)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
interface PluginApi {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;

  /** Full openclaw config object */
  config: Record<string, any>;

  /** THIS plugin's config (from plugins.entries.<id>.config) */
  pluginConfig: Record<string, any> | undefined;

  /** Runtime utilities (tts, stt, embeddings, etc.) */
  runtime: Record<string, any>;

  /** Logger instance — it IS an object with .info/.warn/.debug/.error methods */
  logger: PluginLogger;

  /** Typed lifecycle hooks (before_prompt_build, before_model_resolve, etc.) */
  on(event: string, handler: (...args: any[]) => Promise<any>, options?: { priority?: number }): void;

  /** Event-driven hooks (session:start, message:preprocessed, etc.) */
  registerHook(event: string, handler: (...args: any[]) => Promise<void>, options?: { name?: string; description?: string }): void;

  /** Agent tools */
  registerTool(factory: (ctx: any) => any, options?: { name?: string; optional?: boolean }): void;

  /** HTTP routes on the gateway */
  registerHttpRoute(route: any): void;

  /** Context engine for memory/compaction */
  registerContextEngine(id: string, factory: any): void;

  /** Resolve a path relative to plugin directory */
  resolvePath(path: string): string;
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
    // api.logger is an OBJECT (not a function), use it directly
    const log = api.logger;

    // api.pluginConfig is this plugin's config from openclaw.json
    // plugins.entries.aeronyx-memchain.config
    const userConfig = (api.pluginConfig ?? {}) as Partial<MemChainPluginConfig>;
    const cfg: MemChainPluginConfig = { ...DEFAULT_CONFIG, ...userConfig };

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
