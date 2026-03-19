/**
 * ============================================
 * File: src/hooks/health-hook.ts
 * ============================================
 * Creation Reason: Verify MemChain availability when OpenClaw gateway starts.
 *
 * Main Functionality:
 *   - Hook into "session:start" event (fires on first session)
 *   - Call GET /api/mpi/status to verify MemChain health
 *   - Log status report
 *   - Non-blocking: failure does not prevent OpenClaw from operating
 *
 * Dependencies:
 *   - src/core/client.ts (MemChainClient)
 *
 * ⚠️ Important Note for Next Developer:
 *   - Export function name MUST be registerHealthHook (not registerLogHook)
 *   - This file does NOT import SessionStore — it only needs MemChainClient
 *   - Runs ONCE per gateway lifecycle (uses hasChecked flag)
 *
 * Last Modified: v0.1.0-fix1 — Fixed: correct export name, removed wrong imports
 * ============================================
 */

import type { MemChainClient } from "../core/client.js";

/** Minimal logger interface */
interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** Minimal hook event */
interface HookEvent {
  type: string;
  action: string;
  sessionKey: string;
}

/** Minimal Plugin API */
interface PluginApi {
  registerHook(
    event: string,
    handler: (event: HookEvent) => Promise<void>,
    options?: { name?: string; description?: string },
  ): void;
}

// ---------------------------------------------------------------------------
// Hook Registration
// ---------------------------------------------------------------------------

export function registerHealthHook(
  api: PluginApi,
  client: MemChainClient,
  log: PluginLogger,
): void {
  let hasChecked = false;

  api.registerHook(
    "session:start",
    async (_event: HookEvent): Promise<void> => {
      if (hasChecked) return;
      hasChecked = true;

      try {
        const status = await client.status();

        if (!status) {
          log.warn(
            "🧠 MemChain: UNREACHABLE — memory features will be unavailable. " +
            "Ensure AeroNyx server is running and MPI endpoint is accessible.",
          );
          return;
        }

        const checks = [
          status.memchain_enabled ? "✅ Engine enabled" : "❌ Engine disabled",
          status.index_ready ? "✅ Index ready" : "⚠️ Index rebuilding",
          status.embed_ready ? `✅ Embed ready (${status.embed_dim}d)` : "⚠️ Embed not loaded",
          `📊 Schema v${status.schema_version}`,
          `📝 ${status.stats?.total_records ?? 0} memories stored`,
        ];

        // v2.5.0+ fields (optional, may not exist on older Rust versions)
        const statusAny = status as Record<string, unknown>;
        if (typeof statusAny.ner_ready === "boolean") {
          checks.push(statusAny.ner_ready ? "🔍 NER ready" : "⚠️ NER not loaded");
        }
        if (typeof statusAny.graph_enabled === "boolean") {
          checks.push(statusAny.graph_enabled ? "🕸️ Graph enabled" : "📊 Graph disabled");
        }

        // Graph stats (v2.5.0+)
        const graphStats = statusAny.graph_stats as Record<string, number> | undefined;
        if (graphStats) {
          checks.push(
            `🔗 ${graphStats.entities ?? 0} entities, ${graphStats.communities ?? 0} communities`,
          );
        }

        // SuperNode (v2.5.0+)
        const supernode = statusAny.supernode as Record<string, unknown> | undefined;
        if (supernode?.enabled) {
          checks.push(`⚡ SuperNode active (${supernode.provider_count ?? 0} providers)`);
        }

        if (status.mvf) {
          checks.push(
            status.mvf.enabled
              ? `🧪 MVF active (α=${status.mvf.alpha})`
              : `🧪 MVF standby (α=${status.mvf.alpha})`,
          );
        }

        log.info(`🧠 MemChain: CONNECTED — ${checks.join(" | ")}`);

        if (!status.index_ready) {
          log.warn(
            "🧠 MemChain: Vector index not ready — recall results may be incomplete.",
          );
        }

        if (!status.embed_ready) {
          log.warn(
            "🧠 MemChain: Local embedding engine not loaded — recall will fail.",
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`🧠 MemChain: Health check error — ${message}`);
      }
    },
    {
      name: "memchain.health-check",
      description: "Check MemChain availability on gateway startup",
    },
  );
}
