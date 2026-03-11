/**
 * ============================================
 * File: src/core/client.ts
 * ============================================
 * Creation Reason: Centralized HTTP client for all MemChain MPI endpoints.
 *
 * v0.2.0 Changes:
 *   - Added "remote" mode with Ed25519 signature authentication
 *   - Added end-to-end encryption (ChaCha20-Poly1305) for content fields
 *   - Added automatic Ed25519 key pair generation + file storage
 *   - Local mode behavior is 100% unchanged
 *   - /log returns null in remote mode (403 expected, not an error)
 *
 * Main Logical Flow (remote mode):
 *   1. On init: load or generate Ed25519 key pair from keyStorePath
 *   2. Derive record_key via HKDF-SHA256 for content encryption
 *   3. On request: sign with Ed25519, add X-MemChain-* headers
 *   4. On remember: encrypt content field before sending
 *   5. On recall: decrypt content fields after receiving
 *
 * Dependencies:
 *   - @noble/ed25519 (Ed25519 sign/verify)
 *   - @noble/hashes (SHA256, HMAC, HKDF)
 *   - @noble/ciphers (ChaCha20-Poly1305)
 *   - src/types/memchain.ts (all request/response types)
 *   - Node.js built-in: fs, path, os, crypto (for file I/O only)
 *
 * ⚠️ Important Note for Next Developer:
 *   - ALL methods still return T | null — null means unavailable
 *   - Remote mode /log returns null by design (403 is expected)
 *   - Embedding fields are NEVER encrypted (node needs them for vector search)
 *   - Deterministic nonce (HMAC-based) is required for dedup to work
 *   - Key file permissions must be 600 — do not change this
 *   - Timestamp tolerance is ±300 seconds (5 minutes)
 *
 * Last Modified: v0.2.0 — Added remote mode (Ed25519 + E2E encryption)
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
  Memory,
} from "../types/memchain.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MemChainClientConfig {
  /** "local" or "remote" */
  mode: "local" | "remote";
  /** Base URL: localhost for local, remote node URL for remote */
  baseUrl: string;
  /** Remote node URL (only used in remote mode) */
  nodeUrl: string;
  /** Path to Ed25519 key file */
  keyStorePath: string;
  /** Default embedding model identifier */
  embeddingModel: string;
  /** Default source_ai identifier */
  sourceAi: string;
  /** HTTP request timeout in milliseconds */
  timeout: number;
  /** Plugin logger */
  logger: PluginLogger;
}

interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Key Store Types
// ---------------------------------------------------------------------------

interface KeyStore {
  privateKey: string; // 64-char hex (32 bytes)
  publicKey: string;  // 64-char hex (32 bytes)
  createdAt: string;  // ISO 8601
}

// ---------------------------------------------------------------------------
// MemChain HTTP Client
// ---------------------------------------------------------------------------

export class MemChainClient {
  private readonly cfg: MemChainClientConfig;

  // Ed25519 keys (remote mode only, loaded lazily)
  private privateKey: Uint8Array | null = null;
  private publicKey: Uint8Array | null = null;
  private publicKeyHex: string = "";

  // Derived record encryption key (remote mode only)
  private recordKey: Uint8Array | null = null;

  // Initialization state
  private initialized = false;

  constructor(cfg: MemChainClientConfig) {
    this.cfg = cfg;
  }

  // -------------------------------------------------------------------------
  // Lazy initialization (loads keys on first use in remote mode)
  // -------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (this.cfg.mode !== "remote") return;

    try {
      await this.loadOrGenerateKeys();
      this.deriveRecordKey();
      this.cfg.logger.info("[MemChain] Remote mode initialized", {
        publicKey: this.publicKeyHex.slice(0, 16) + "...",
        keyStore: this.cfg.keyStorePath,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.cfg.logger.error("[MemChain] Failed to initialize remote mode keys", { error: msg });
      // Mark as not initialized so it can retry
      this.initialized = false;
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

    // Decrypt content fields in remote mode
    if (result?.memories && this.cfg.mode === "remote") {
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

    // Encrypt content field in remote mode
    // Note: embedding is NEVER encrypted (node needs it for vector search)
    if (this.cfg.mode === "remote") {
      body.content = this.encryptContent(body.content);
    }

    return this.request<RememberResponse>("POST", "/api/mpi/remember", body);
  }

  async forget(recordId: string): Promise<ForgetResponse | null> {
    const req: ForgetRequest = { record_id: recordId };
    return this.request<ForgetResponse>("POST", "/api/mpi/forget", req);
  }

  async log(req: LogRequest): Promise<LogResponse | null> {
    // Remote mode: /log is forbidden (403) — skip silently
    if (this.cfg.mode === "remote") {
      this.cfg.logger.debug("[MemChain] /log skipped in remote mode (forbidden by node)");
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
  // Ed25519 Key Management
  // -------------------------------------------------------------------------

  /**
   * Load existing keys from keyStorePath, or generate new ones.
   * File permissions are set to 600 (owner-only).
   */
  private async loadOrGenerateKeys(): Promise<void> {
    const keyPath = this.resolveKeyPath();

    if (existsSync(keyPath)) {
      // Load existing keys
      const raw = readFileSync(keyPath, "utf-8");
      const store: KeyStore = JSON.parse(raw);

      if (!store.privateKey || !store.publicKey) {
        throw new Error("Invalid key store: missing privateKey or publicKey");
      }

      this.privateKey = hexToBytes(store.privateKey);
      this.publicKey = hexToBytes(store.publicKey);
      this.publicKeyHex = store.publicKey;

      this.cfg.logger.info("[MemChain] Loaded Ed25519 keys from disk", {
        path: keyPath,
        publicKey: this.publicKeyHex.slice(0, 16) + "...",
      });
    } else {
      // Generate new key pair
      this.privateKey = ed.utils.randomPrivateKey();
      this.publicKey = await ed.getPublicKeyAsync(this.privateKey);
      this.publicKeyHex = bytesToHex(this.publicKey);

      const store: KeyStore = {
        privateKey: bytesToHex(this.privateKey),
        publicKey: this.publicKeyHex,
        createdAt: new Date().toISOString(),
      };

      writeFileSync(keyPath, JSON.stringify(store, null, 2) + "\n", "utf-8");

      // Set permissions to 600 (owner read/write only)
      try {
        chmodSync(keyPath, 0o600);
      } catch {
        this.cfg.logger.warn("[MemChain] Could not set key file permissions to 600");
      }

      this.cfg.logger.info("[MemChain] Generated new Ed25519 key pair", {
        path: keyPath,
        publicKey: this.publicKeyHex.slice(0, 16) + "...",
      });
    }
  }

  /**
   * Resolve ~ in keyStorePath to actual home directory.
   */
  private resolveKeyPath(): string {
    let p = this.cfg.keyStorePath;
    if (p.startsWith("~/")) {
      p = resolve(homedir(), p.slice(2));
    }
    return resolve(p);
  }

  // -------------------------------------------------------------------------
  // Record Key Derivation (for content encryption)
  // -------------------------------------------------------------------------

  /**
   * Derive record encryption key from Ed25519 private key using HKDF-SHA256.
   *
   * record_key = HKDF-SHA256(
   *   ikm: Ed25519 private key (32 bytes),
   *   salt: "memchain-records" (UTF-8),
   *   info: "v1" (UTF-8),
   *   output: 32 bytes
   * )
   */
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

  /**
   * Encrypt plaintext content for remote storage.
   *
   * Uses deterministic nonce (HMAC-based) so identical content
   * produces identical ciphertext — required for dedup to work.
   *
   * Format: hex(nonce(12 bytes) || ciphertext)
   */
  private encryptContent(plaintext: string): string {
    if (!this.recordKey) return plaintext;

    try {
      const plaintextBytes = utf8ToBytes(plaintext);

      // Deterministic nonce: HMAC-SHA256(record_key, plaintext)[0..12]
      const nonceHash = hmac(sha256, this.recordKey, plaintextBytes);
      const nonce = nonceHash.slice(0, 12);

      // Encrypt with ChaCha20-Poly1305
      const cipher = chacha20poly1305(this.recordKey, nonce);
      const ciphertext = cipher.encrypt(plaintextBytes);

      // Concatenate nonce + ciphertext and hex-encode
      return bytesToHex(concatBytes(nonce, ciphertext));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.cfg.logger.warn("[MemChain] Encryption failed, sending plaintext", { error: msg });
      return plaintext;
    }
  }

  /**
   * Decrypt content received from remote node.
   *
   * Input: hex-encoded string of nonce(12) || ciphertext
   * Output: UTF-8 plaintext
   *
   * Falls back to returning input as-is if decryption fails
   * (handles case where content was stored in plaintext).
   */
  private decryptContent(content: string): string {
    if (!this.recordKey) return content;

    try {
      // Check if content looks like hex-encoded ciphertext
      // Minimum: 12 bytes nonce + 16 bytes auth tag = 56 hex chars
      if (!/^[0-9a-f]{56,}$/i.test(content)) {
        return content; // Not encrypted, return as-is
      }

      const data = hexToBytes(content);
      if (data.length < 28) return content; // Too short for nonce + tag

      const nonce = data.slice(0, 12);
      const ciphertext = data.slice(12);

      const cipher = chacha20poly1305(this.recordKey, nonce);
      const plaintext = cipher.decrypt(ciphertext);

      return new TextDecoder().decode(plaintext);
    } catch {
      // Decryption failed — content might be plaintext or encrypted with different key
      return content;
    }
  }

  // -------------------------------------------------------------------------
  // Request Signing (Ed25519)
  // -------------------------------------------------------------------------

  /**
   * Generate Ed25519 signature headers for a request.
   *
   * Signature message: SHA256(timestamp + method + path + SHA256(body))
   *
   * Returns headers:
   *   X-MemChain-PublicKey:  hex public key (64 chars)
   *   X-MemChain-Timestamp: unix timestamp string
   *   X-MemChain-Signature: hex signature (128 chars)
   */
  private async signRequest(
    method: string,
    path: string,
    bodyBytes: Uint8Array,
  ): Promise<Record<string, string>> {
    if (!this.privateKey || !this.publicKey) {
      throw new Error("Keys not loaded — cannot sign request");
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Construct signed message: SHA256(timestamp + method + path + SHA256(body))
    const bodyHash = sha256(bodyBytes);
    const message = sha256(
      concatBytes(
        utf8ToBytes(timestamp),
        utf8ToBytes(method.toUpperCase()),
        utf8ToBytes(path),
        bodyHash,
      ),
    );

    // Sign the 32-byte message hash
    const signature = await ed.signAsync(message, this.privateKey);

    return {
      "X-MemChain-PublicKey": this.publicKeyHex,
      "X-MemChain-Timestamp": timestamp,
      "X-MemChain-Signature": bytesToHex(signature),
    };
  }

  // -------------------------------------------------------------------------
  // HTTP Transport — mode-aware request dispatcher
  // -------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    // Ensure keys are loaded for remote mode
    await this.ensureInitialized();

    const isRemote = this.cfg.mode === "remote";
    const baseUrl = isRemote ? this.cfg.nodeUrl : this.cfg.baseUrl;
    const url = `${baseUrl}${path}`;

    const bodyStr = body ? JSON.stringify(body) : undefined;
    const bodyBytes = bodyStr ? utf8ToBytes(bodyStr) : new Uint8Array(0);

    // Build headers
    const headers: Record<string, string> = {};
    if (bodyStr) {
      headers["Content-Type"] = "application/json";
    }

    if (isRemote) {
      // Remote mode: Ed25519 signature authentication
      try {
        const signHeaders = await this.signRequest(method, path, bodyBytes);
        Object.assign(headers, signHeaders);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.cfg.logger.warn(`[MemChain] Failed to sign request ${path}`, { error: msg });
        return null;
      }
    }
    // Local mode: no auth headers needed (Bearer token handled by MemChain server config)

    // Execute request with timeout
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
        // Remote mode: 403 on /log is expected, not an error
        if (isRemote && res.status === 403 && path === "/api/mpi/log") {
          return null;
        }

        this.cfg.logger.warn(`[MemChain] ${method} ${path} returned ${res.status}`, {
          status: res.status,
          statusText: res.statusText,
          mode: this.cfg.mode,
        });
        return null;
      }

      return (await res.json()) as T;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof DOMException && err.name === "AbortError") {
        this.cfg.logger.warn(`[MemChain] ${method} ${path} timed out after ${this.cfg.timeout}ms`);
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
}
