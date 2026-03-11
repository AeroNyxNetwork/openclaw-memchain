/**
 * ============================================
 * File: src/index.ts
 * ============================================
 * Creation Reason: Main entry point for aeronyx-memchain plugin.
 *
 * v0.2.0 Changes:
 *   - Added mode/nodeUrl/keyStorePath to default config
 *   - Pass new fields to MemChainClient constructor
 *   - Log mode on initialization
 *
 * Last Modified: v0.2.0 — Remote mode support
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
  mode: "local",
  memchainUrl: "http://127.0.0.1:8421",
  nodeUrl: "",
  keyStorePath: "~/.openclaw/memchain-keys.json",
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
// Plugin Definition
// ---------------------------------------------------------------------------

export default {
  id: "aeronyx-memchain",
  name: "AeroNyx MemChain",
  description:
    "4-layer cognitive memory with MVF scoring, negative feedback learning, " +
    "and co-occurrence graph. Supports local and remote modes with Ed25519 " +
    "authentication and end-to-end encryption.",
  kind: "memory",
  configSchema: configSchema(),

  register(api: PluginApi): void {
    const log = api.logger;
    const userConfig = (api.pluginConfig ?? {}) as Partial<MemChainPluginConfig>;
    const cfg: MemChainPluginConfig = { ...DEFAULT_CONFIG, ...userConfig };

    // Validate remote mode config
    if (cfg.mode === "remote" && !cfg.nodeUrl) {
      log.error("[MemChain] Remote mode requires nodeUrl to be set. Falling back to local mode.");
      cfg.mode = "local";
    }

    log.info("[MemChain] Initializing plugin", {
      mode: cfg.mode,
      url: cfg.mode === "local" ? cfg.memchainUrl : cfg.nodeUrl,
      embeddingModel: cfg.embeddingModel,
      autoRecall: cfg.enableAutoRecall,
      autoLog: cfg.enableAutoLog,
    });

    // Initialize MemChain HTTP client
    const client = new MemChainClient({
      mode: cfg.mode,
      baseUrl: cfg.memchainUrl || "http://127.0.0.1:8421",
      nodeUrl: cfg.nodeUrl || "",
      keyStorePath: cfg.keyStorePath || "~/.openclaw/memchain-keys.json",
      embeddingModel: cfg.embeddingModel || "minilm-l6-v2",
      sourceAi: cfg.sourceAi || "openclaw-memchain",
      timeout: cfg.timeout || 5000,
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

    log.info("[MemChain] Plugin registered successfully", {
      mode: cfg.mode,
      hooks: ["recall", "log", "health"],
      tools: ["memchain_remember", "memchain_forget", "memchain_recall"],
    });
  },
};
