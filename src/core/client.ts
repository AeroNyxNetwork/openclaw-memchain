/**
 * ============================================
 * File: src/core/client.ts
 * ============================================
 * v0.3.0 Changes:
 *   - Added "cloud" mode: plugin → CMS → WS → node
 *   - Cloud mode uses Bearer token (CMS auth) + Ed25519 signature (node auth)
 *   - Cloud mode MPI path: /api/privacy_network/memchain/mpi/<endpoint>
 *   - Cloud mode startup: register-pubkey → check bindings → auto-assign
 *   - Cloud mode E2E encryption: same as remote (content encrypted, embedding not)
 *   - /log disabled in both remote and cloud modes
 *
 * Three modes:
 *   local:  Bearer token + localhost + plaintext
 *   remote: Ed25519 sign + direct node + E2E encrypt
 *   cloud:  Bearer + Ed25519 sign + CMS relay + E2E encrypt
 *
 * ⚠️ Important Note for Next Developer:
 *   - Cloud mode has TWO auth layers: Bearer (CMS) + Ed25519 (node, transparent)
 *   - CMS MPI path prefix: /api/privacy_network/memchain/mpi/
 *   - Cloud startup calls 3 CMS endpoints before first MPI request
 *   - If CMS startup fails, all MPI calls return null (graceful degradation)
 *
 * Last Modified: v0.3.0 — Added cloud mode (CMS relay + E2E encryption)
 * ============================================
 */

import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import { hkdf } from "@noble/hashes/hkdf";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { concatBytes, utf8ToBytes, hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

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
  SearchResponse,
  ContextInjectResponse,
  SessionDetailResponse,
  ConversationResponse,
} from "../types/memchain.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MemChainClientConfig {
  mode: "local" | "remote" | "cloud";
  baseUrl: string;
  nodeUrl: string;
  cmsUrl: string;
  apiKey: string;
  keyStorePath: string;
  embeddingModel: string;
  sourceAi: string;
  timeout: number;
  logger: PluginLogger;
}

interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

interface KeyStore {
  privateKey: string;
  publicKey: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// CMS API response types
// ---------------------------------------------------------------------------

interface CmsBindingResponse {
  bindings: Array<{
    node_id: string;
    status: string;
  }>;
}

// ---------------------------------------------------------------------------
// MemChain HTTP Client
// ---------------------------------------------------------------------------

export class MemChainClient {
  private readonly cfg: MemChainClientConfig;

  // Ed25519 keys (remote + cloud modes)
  private privateKey: Uint8Array | null = null;
  private publicKey: Uint8Array | null = null;
  private publicKeyHex: string = "";

  // Derived record encryption key
  private recordKey: Uint8Array | null = null;

  // Initialization state
  private initialized = false;
  private cloudReady = false;

  constructor(cfg: MemChainClientConfig) {
    this.cfg = cfg;
  }

  // -------------------------------------------------------------------------
  // Lazy initialization
  // -------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (this.cfg.mode === "local") return;

    try {
      // Both remote and cloud need Ed25519 keys
      await this.loadOrGenerateKeys();
      this.deriveRecordKey();

      // Cloud mode: register pubkey + check/assign binding
      if (this.cfg.mode === "cloud") {
        await this.cloudStartup();
      }

      this.cfg.logger.info("[MemChain] Initialized", {
        mode: this.cfg.mode,
        publicKey: this.publicKeyHex.slice(0, 16) + "...",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.cfg.logger.error("[MemChain] Initialization failed", {
        mode: this.cfg.mode,
        error: msg,
      });
      this.initialized = false;
    }
  }

  // -------------------------------------------------------------------------
  // Cloud mode startup: register pubkey → check bindings → auto-assign
  // -------------------------------------------------------------------------

  private async cloudStartup(): Promise<void> {
    const cmsUrl = this.cfg.cmsUrl.replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.cfg.apiKey}`,
    };

    // Step 1: Register public key with CMS
    try {
      const regRes = await fetch(
        `${cmsUrl}/api/privacy_network/memchain/register-pubkey/`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ public_key: this.publicKeyHex }),
        },
      );

      if (!regRes.ok && regRes.status !== 409) {
        // 409 = already registered, that's fine
        this.cfg.logger.warn("[MemChain] Cloud: pubkey registration failed", {
          status: regRes.status,
        });
      } else {
        this.cfg.logger.info("[MemChain] Cloud: pubkey registered");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.cfg.logger.warn("[MemChain] Cloud: pubkey registration error", { error: msg });
    }

    // Step 2: Check existing bindings
    try {
      const bindRes = await fetch(
        `${cmsUrl}/api/privacy_network/memchain/bindings/`,
        { method: "GET", headers },
      );

      if (bindRes.ok) {
        const data = (await bindRes.json()) as CmsBindingResponse;
        const active = data.bindings?.filter((b) => b.status === "active") ?? [];

        if (active.length > 0) {
          this.cloudReady = true;
          this.cfg.logger.info("[MemChain] Cloud: binding found", {
            nodeId: active[0].node_id,
          });
          return;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.cfg.logger.warn("[MemChain] Cloud: binding check error", { error: msg });
    }

    // Step 3: No binding — auto-assign a node
    try {
      const assignRes = await fetch(
        `${cmsUrl}/api/privacy_network/memchain/assign/`,
        { method: "POST", headers },
      );

      if (assignRes.ok) {
        this.cloudReady = true;
        this.cfg.logger.info("[MemChain] Cloud: node auto-assigned");
      } else {
        this.cfg.logger.warn("[MemChain] Cloud: node assignment failed", {
          status: assignRes.status,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.cfg.logger.warn("[MemChain] Cloud: node assignment error", { error: msg });
    }
  }

  // -------------------------------------------------------------------------
  // Public API — one method per MPI endpoint
  // -------------------------------------------------------------------------

  async embed(texts: string[]): Promise<EmbedResponse | null> {
    if (!texts.length) return null;
    const batch = texts.slice(0, 100);
    const req: EmbedRequest = { texts: batch, model: this.cfg.embeddingModel };
    return this.request<EmbedResponse>("POST", "/api/mpi/embed", req);
  }

  async embedSingle(text: string): Promise<number[] | null> {
    const resp = await this.embed([text]);
    if (!resp?.embeddings?.length) return null;
    return resp.embeddings[0];
  }

  async recall(req: RecallRequest): Promise<RecallResponse | null> {
    const result = await this.request<RecallResponse>("POST", "/api/mpi/recall", {
      ...req,
      embedding_model: req.embedding_model || this.cfg.embeddingModel,
    });

    // Decrypt content in remote and cloud modes
    if (result?.memories && this.isEncryptedMode()) {
      for (const memory of result.memories) {
        memory.content = this.decryptContent(memory.content);
      }
    }

    return result;
  }

  async remember(req: RememberRequest): Promise<RememberResponse | null> {
    const body = {
      ...req,
      source_ai: req.source_ai || this.cfg.sourceAi,
      embedding_model: req.embedding_model || this.cfg.embeddingModel,
    };

    // Encrypt content in remote and cloud modes
    if (this.isEncryptedMode()) {
      body.content = this.encryptContent(body.content);
    }

    return this.request<RememberResponse>("POST", "/api/mpi/remember", body);
  }

  async forget(recordId: string): Promise<ForgetResponse | null> {
    const req: ForgetRequest = { record_id: recordId };
    return this.request<ForgetResponse>("POST", "/api/mpi/forget", req);
  }

  async log(req: LogRequest): Promise<LogResponse | null> {
    // Remote and cloud modes: /log is forbidden — skip silently
    if (this.cfg.mode === "remote" || this.cfg.mode === "cloud") {
      this.cfg.logger.debug("[MemChain] /log skipped in " + this.cfg.mode + " mode");
      return null;
    }

    return this.request<LogResponse>("POST", "/api/mpi/log", {
      ...req,
      source_ai: req.source_ai || this.cfg.sourceAi,
    });
  }

  async status(): Promise<StatusResponse | null> {
    return this.request<StatusResponse>("GET", "/api/mpi/status");
  }

  // -------------------------------------------------------------------------
  // v2.5.0+ endpoints
  // -------------------------------------------------------------------------

  /**
   * BM25 full-text search with highlighted snippets.
   * Results are grouped by session.
   */
  async search(query: string, limit: number = 10): Promise<SearchResponse | null> {
    return this.request<SearchResponse>(
      "GET",
      `/api/mpi/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  }

  /**
   * Get pre-formatted context for system prompt injection.
   * Returns project context, recent session summaries, and key entities.
   * The formatted_context field is ready to inject directly.
   */
  async getContextInjection(maxTokens: number = 500): Promise<ContextInjectResponse | null> {
    return this.request<ContextInjectResponse>(
      "GET",
      `/api/mpi/context/inject?max_tokens=${maxTokens}&recent_sessions=3`,
    );
  }

  /**
   * Get session details (title, summary, entities, artifacts).
   */
  async getSession(sessionId: string): Promise<SessionDetailResponse | null> {
    return this.request<SessionDetailResponse>(
      "GET",
      `/api/mpi/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  /**
   * Replay a previous conversation (decrypted turns).
   */
  async getConversation(sessionId: string): Promise<ConversationResponse | null> {
    const result = await this.request<ConversationResponse>(
      "GET",
      `/api/mpi/sessions/${encodeURIComponent(sessionId)}/conversation`,
    );

    // Decrypt turn content in remote/cloud modes
    if (result?.turns && this.isEncryptedMode()) {
      for (const turn of result.turns) {
        if (turn.content && !turn.encrypted) {
          turn.content = this.decryptContent(turn.content);
        }
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Helper: is this an encrypted mode?
  // -------------------------------------------------------------------------

  private isEncryptedMode(): boolean {
    return this.cfg.mode === "remote" || this.cfg.mode === "cloud";
  }

  // -------------------------------------------------------------------------
  // Ed25519 Key Management (shared by remote + cloud)
  // -------------------------------------------------------------------------

  private async loadOrGenerateKeys(): Promise<void> {
    const keyPath = this.resolveKeyPath();

    if (existsSync(keyPath)) {
      const raw = readFileSync(keyPath, "utf-8");
      const store: KeyStore = JSON.parse(raw);

      if (!store.privateKey || !store.publicKey) {
        throw new Error("Invalid key store: missing privateKey or publicKey");
      }

      this.privateKey = hexToBytes(store.privateKey);
      this.publicKey = hexToBytes(store.publicKey);
      this.publicKeyHex = store.publicKey;

      this.cfg.logger.info("[MemChain] Loaded Ed25519 keys", { path: keyPath });
    } else {
      this.privateKey = ed.utils.randomPrivateKey();
      this.publicKey = await ed.getPublicKeyAsync(this.privateKey);
      this.publicKeyHex = bytesToHex(this.publicKey);

      const store: KeyStore = {
        privateKey: bytesToHex(this.privateKey),
        publicKey: this.publicKeyHex,
        createdAt: new Date().toISOString(),
      };

      writeFileSync(keyPath, JSON.stringify(store, null, 2) + "\n", "utf-8");
      try {
        chmodSync(keyPath, 0o600);
      } catch {
        this.cfg.logger.warn("[MemChain] Could not set key file permissions to 600");
      }

      this.cfg.logger.info("[MemChain] Generated new Ed25519 key pair", { path: keyPath });
    }
  }

  private resolveKeyPath(): string {
    let p = this.cfg.keyStorePath;
    if (p.startsWith("~/")) {
      p = resolve(homedir(), p.slice(2));
    }
    return resolve(p);
  }

  // -------------------------------------------------------------------------
  // Record Key Derivation
  // -------------------------------------------------------------------------

  private deriveRecordKey(): void {
    if (!this.privateKey) throw new Error("Private key not loaded");
    this.recordKey = hkdf(
      sha256,
      this.privateKey,
      utf8ToBytes("memchain-records"),
      utf8ToBytes("v1"),
      32,
    );
  }

  // -------------------------------------------------------------------------
  // Content Encryption / Decryption (ChaCha20-Poly1305)
  // -------------------------------------------------------------------------

  private encryptContent(plaintext: string): string {
    if (!this.recordKey) return plaintext;
    try {
      const plaintextBytes = utf8ToBytes(plaintext);
      const nonceHash = hmac(sha256, this.recordKey, plaintextBytes);
      const nonce = nonceHash.slice(0, 12);
      const cipher = chacha20poly1305(this.recordKey, nonce);
      const ciphertext = cipher.encrypt(plaintextBytes);
      return bytesToHex(concatBytes(nonce, ciphertext));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.cfg.logger.warn("[MemChain] Encryption failed, sending plaintext", { error: msg });
      return plaintext;
    }
  }

  private decryptContent(content: string): string {
    if (!this.recordKey) return content;
    try {
      if (!/^[0-9a-f]{56,}$/i.test(content)) {
        return content;
      }
      const data = hexToBytes(content);
      if (data.length < 28) return content;
      const nonce = data.slice(0, 12);
      const ciphertext = data.slice(12);
      const cipher = chacha20poly1305(this.recordKey, nonce);
      const plaintext = cipher.decrypt(ciphertext);
      return new TextDecoder().decode(plaintext);
    } catch {
      return content;
    }
  }

  // -------------------------------------------------------------------------
  // Request Signing (Ed25519) — used by remote + cloud
  // -------------------------------------------------------------------------

  private async signRequest(
    method: string,
    path: string,
    bodyBytes: Uint8Array,
  ): Promise<Record<string, string>> {
    if (!this.privateKey || !this.publicKey) {
      throw new Error("Keys not loaded — cannot sign request");
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyHash = sha256(bodyBytes);
    const message = sha256(
      concatBytes(
        utf8ToBytes(timestamp),
        utf8ToBytes(method.toUpperCase()),
        utf8ToBytes(path),
        bodyHash,
      ),
    );

    const signature = await ed.signAsync(message, this.privateKey);

    return {
      "X-MemChain-PublicKey": this.publicKeyHex,
      "X-MemChain-Timestamp": timestamp,
      "X-MemChain-Signature": bytesToHex(signature),
    };
  }

  // -------------------------------------------------------------------------
  // HTTP Transport — three-mode dispatcher
  // -------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    await this.ensureInitialized();

    // Build URL and headers based on mode
    const { url, headers: modeHeaders } = await this.buildRequest(method, path, body);

    const bodyStr = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { ...modeHeaders };
    if (bodyStr) {
      headers["Content-Type"] = "application/json";
    }

    // Execute with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeout);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: bodyStr || undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        // Remote/cloud: 403 on /log is expected
        if ((this.cfg.mode === "remote" || this.cfg.mode === "cloud") &&
            res.status === 403 && path === "/api/mpi/log") {
          return null;
        }

        this.cfg.logger.warn(`[MemChain] ${method} ${path} → ${res.status}`, {
          mode: this.cfg.mode,
          status: res.status,
        });
        return null;
      }

      return (await res.json()) as T;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof DOMException && err.name === "AbortError") {
        this.cfg.logger.warn(`[MemChain] ${method} ${path} timed out`);
      } else {
        this.cfg.logger.warn(`[MemChain] ${method} ${path} failed`, {
          error: message,
          mode: this.cfg.mode,
        });
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build URL and auth headers for the current mode.
   *
   * Local:  http://localhost:8421/api/mpi/<endpoint>
   *         No auth headers (Bearer handled by server config)
   *
   * Remote: http://nodeIP:8421/api/mpi/<endpoint>
   *         X-MemChain-PublicKey + Timestamp + Signature
   *
   * Cloud:  https://cms-url/api/privacy_network/memchain/mpi/<endpoint>
   *         Authorization: Bearer sk-xxx  (CMS auth)
   *         X-MemChain-PublicKey + Timestamp + Signature  (node auth, CMS transparent)
   */
  private async buildRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const bodyBytes = bodyStr ? utf8ToBytes(bodyStr) : new Uint8Array(0);

    if (this.cfg.mode === "local") {
      // Local: direct to localhost, no auth headers
      return {
        url: `${this.cfg.baseUrl}${path}`,
        headers: {},
      };
    }

    if (this.cfg.mode === "remote") {
      // Remote: direct to node, Ed25519 sign
      const signHeaders = await this.signRequest(method, path, bodyBytes);
      return {
        url: `${this.cfg.nodeUrl}${path}`,
        headers: signHeaders,
      };
    }

    // Cloud: CMS relay, Bearer + Ed25519 sign
    // Path transformation: /api/mpi/remember → /api/privacy_network/memchain/mpi/remember
    const endpoint = path.replace("/api/mpi/", "");
    const cmsPath = `/api/privacy_network/memchain/mpi/${endpoint}`;
    const cmsUrl = this.cfg.cmsUrl.replace(/\/+$/, "");

    // Sign against the ORIGINAL MPI path (node verifies this, not the CMS path)
    const signHeaders = await this.signRequest(method, path, bodyBytes);

    return {
      url: `${cmsUrl}${cmsPath}`,
      headers: {
        "Authorization": `Bearer ${this.cfg.apiKey}`,
        ...signHeaders,
      },
    };
  }
}
