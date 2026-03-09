/**
 * ============================================
 * File: src/index.ts
 * ============================================
 * Creation Reason: Main entry point for @aeronyx/openclaw-memchain plugin.
 *
 * Last Modified: v0.1.3 — Fixed registerTool type: options uses { names: string[] }
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
// Plugin API type (actual shape from OpenClaw 2026.3.7)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
interface PluginApi {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  config: Record<string, any>;
  pluginConfig: Record<string, any> | undefined;
  runtime: Record<string, any>;
  logger: PluginLogger;

  on(event: string, handler: (...args: any[]) => Promise<any>, options?: { priority?: number }): void;
  registerHook(event: string, handler: (...args: any[]) => Promise<void>, options?: { name?: string; description?: string }): void;
  registerTool(factory: (ctx: any) => any | any[] | null, options: { names: string[] }): void;
  registerHttpRoute(route: any): void;
  registerContextEngine(id: string, factory: any): void;
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
    const log = api.logger;
    const userConfig = (api.pluginConfig ?? {}) as Partial<MemChainPluginConfig>;
    const cfg: MemChainPluginConfig = { ...DEFAULT_CONFIG, ...userConfig };

    log.info("Initializing AeroNyx MemChain plugin", {
      memchainUrl: cfg.memchainUrl,
      embeddingModel: cfg.embeddingModel,
      autoRecall: cfg.enableAutoRecall,
      autoLog: cfg.enableAutoLog,
    });

    const client = new MemChainClient({
      baseUrl: cfg.memchainUrl,
      embeddingModel: cfg.embeddingModel,
      sourceAi: cfg.sourceAi,
      timeout: cfg.timeout,
      logger: log,
    });

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
