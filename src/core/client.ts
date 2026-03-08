/**
 * ============================================
 * File: src/core/client.ts
 * ============================================
 * Creation Reason: Centralized HTTP client for all MemChain MPI endpoints.
 *   Every hook and tool calls MemChain through this client, ensuring
 *   consistent error handling, timeouts, and logging.
 *
 * Main Functionality:
 *   - embed()    → POST /api/mpi/embed    (text → embedding vectors)
 *   - recall()   → POST /api/mpi/recall   (embedding → ranked memories)
 *   - remember() → POST /api/mpi/remember (store new memory)
 *   - forget()   → POST /api/mpi/forget   (delete memory)
 *   - log()      → POST /api/mpi/log      (conversation turns → rule engine)
 *   - status()   → GET  /api/mpi/status   (health check)
 *
 * Dependencies:
 *   - src/types/memchain.ts (all request/response types)
 *   - Node.js built-in fetch (Node >= 22, no external HTTP library)
 *   - Referenced by: hooks/recall-hook.ts, hooks/log-hook.ts,
 *     hooks/health-hook.ts, tools/remember-tool.ts, tools/forget-tool.ts,
 *     tools/recall-tool.ts
 *
 * Main Logical Flow:
 *   1. Caller invokes a typed method (e.g. client.recall(req))
 *   2. Method delegates to private request() with path + body
 *   3. request() builds fetch() call with timeout via AbortController
 *   4. On success: parse JSON, return typed response
 *   5. On failure: log warning, return null (graceful degradation)
 *
 * ⚠️ Important Note for Next Developer:
 *   - ALL methods return T | null — null means MemChain is unavailable
 *   - Callers MUST handle null gracefully (skip memory, not crash)
 *   - Timeout is per-request, not global
 *   - Do NOT throw exceptions from public methods
 *
 * Last Modified: v0.1.0-fix1 — Fixed: added export keyword to class and interface
 * ============================================
 */

import type {
  EmbedRequest,
  EmbedResponse,
  RecallRequest,
  RecallResponse,
  RememberRequest,
  RememberResponse,
  ForgetRequest,
  ForgetResponse,
  LogRequest,
  LogResponse,
  StatusResponse,
} from "../types/memchain.js";

// ---------------------------------------------------------------------------
// Client Configuration
// ---------------------------------------------------------------------------

export interface MemChainClientConfig {
  /** Base URL of MemChain MPI (e.g. "http://127.0.0.1:8421") */
  baseUrl: string;
  /** Default embedding model identifier */
  embeddingModel: string;
  /** Default source_ai identifier */
  sourceAi: string;
  /** HTTP request timeout in milliseconds */
  timeout: number;
  /** OpenClaw plugin logger instance */
  logger: PluginLogger;
}

/** Minimal logger interface matching OpenClaw's api.logger() */
interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// MemChain HTTP Client
// ---------------------------------------------------------------------------

export class MemChainClient {
  private readonly cfg: MemChainClientConfig;

  constructor(cfg: MemChainClientConfig) {
    this.cfg = cfg;
  }

  // -------------------------------------------------------------------------
  // Public API — one method per MPI endpoint
  // -------------------------------------------------------------------------

  async embed(texts: string[]): Promise<EmbedResponse | null> {
    if (!texts.length) return null;
    const batch = texts.slice(0, 100);
    const req: EmbedRequest = {
      texts: batch,
      model: this.cfg.embeddingModel,
    };
    return this.request<EmbedResponse>("POST", "/api/mpi/embed", req);
  }

  async embedSingle(text: string): Promise<number[] | null> {
    const resp = await this.embed([text]);
    if (!resp?.embeddings?.length) return null;
    return resp.embeddings[0];
  }

  async recall(req: RecallRequest): Promise<RecallResponse | null> {
    return this.request<RecallResponse>("POST", "/api/mpi/recall", {
      ...req,
      embedding_model: req.embedding_model || this.cfg.embeddingModel,
    });
  }

  async remember(req: RememberRequest): Promise<RememberResponse | null> {
    return this.request<RememberResponse>("POST", "/api/mpi/remember", {
      ...req,
      source_ai: req.source_ai || this.cfg.sourceAi,
      embedding_model: req.embedding_model || this.cfg.embeddingModel,
    });
  }

  async forget(recordId: string): Promise<ForgetResponse | null> {
    const req: ForgetRequest = { record_id: recordId };
    return this.request<ForgetResponse>("POST", "/api/mpi/forget", req);
  }

  async log(req: LogRequest): Promise<LogResponse | null> {
    return this.request<LogResponse>("POST", "/api/mpi/log", {
      ...req,
      source_ai: req.source_ai || this.cfg.sourceAi,
    });
  }

  async status(): Promise<StatusResponse | null> {
    return this.request<StatusResponse>("GET", "/api/mpi/status");
  }

  // -------------------------------------------------------------------------
  // Private — HTTP transport with timeout and graceful degradation
  // -------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const url = `${this.cfg.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeout);

    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        this.cfg.logger.warn(`MemChain ${method} ${path} returned ${res.status}`, {
          status: res.status,
          statusText: res.statusText,
        });
        return null;
      }

      return (await res.json()) as T;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof DOMException && err.name === "AbortError") {
        this.cfg.logger.warn(`MemChain ${method} ${path} timed out after ${this.cfg.timeout}ms`);
      } else {
        this.cfg.logger.warn(`MemChain ${method} ${path} failed`, { error: message });
      }

      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
