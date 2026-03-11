/**
 * ============================================
 * File: src/types/memchain.ts
 * ============================================
 * Creation Reason: Define all TypeScript types for the MemChain MPI protocol.
 *   These types mirror the Rust structs in api/mpi.rs and are the single
 *   source of truth for the OpenClaw plugin side.
 *
 * Main Functionality:
 *   - Request/Response types for all 6 MPI endpoints
 *     (remember, recall, forget, log, status, embed)
 *   - Memory layer enum and Memory record interface
 *   - Plugin configuration interface
 *
 * Dependencies:
 *   - None (pure type definitions, no runtime code)
 *   - Referenced by: core/client.ts, core/formatter.ts, hooks/*, tools/*
 *
 * ⚠️ Important Note for Next Developer:
 *   - These types MUST stay in sync with MemChain Rust MPI definitions
 *   - Field names use snake_case to match the JSON wire format
 *   - Do NOT add runtime logic to this file — types only
 *
 * Last Modified: v0.1.0 - Initial creation matching MemChain v2.1.0+MVF
 * ============================================
 */

// ---------------------------------------------------------------------------
// Memory Layer Enum
// ---------------------------------------------------------------------------

/**
 * 4-layer cognitive memory model based on Tulving's dual-memory theory.
 *
 * - identity:  Highest weight, never decays (name, allergies, family)
 * - knowledge: Stable facts, slow decay (preferences, tech stack)
 * - episode:   Daily conversation slices, fast decay (today's lunch)
 * - archive:   Compressed old memories, very low weight, awakened by semantic match
 */
export type MemoryLayer = "identity" | "knowledge" | "episode" | "archive";

// ---------------------------------------------------------------------------
// Memory Record (returned by /recall)
// ---------------------------------------------------------------------------

export interface Memory {
  /** Deterministic hash ID (MemoryRecord::compute_record_id in Rust) */
  record_id: string;
  /** Cognitive layer this memory belongs to */
  layer: MemoryLayer;
  /** Composite cognitive score (V_old or α×V_mvf + (1-α)×V_old) */
  score: number;
  /** Human-readable content (third-person summary) */
  content: string;
  /** Semantic tags (e.g. ["health", "allergy"]) */
  topic_tags: string[];
  /** Unix timestamp (seconds) of when this memory was created */
  timestamp: number;
  /** Number of times this memory has been recalled */
  access_count: number;
}

// ---------------------------------------------------------------------------
// /api/mpi/embed
// ---------------------------------------------------------------------------

export interface EmbedRequest {
  /** Texts to embed (batch, max 100) */
  texts: string[];
  /** Model identifier (optional, defaults to server's configured model) */
  model?: string;
}

export interface EmbedResponse {
  /** Array of embedding vectors, one per input text */
  embeddings: number[][];
  /** Model identifier that produced these embeddings */
  model: string;
  /** Dimensionality of each embedding vector (e.g. 384) */
  dim: number;
}

// ---------------------------------------------------------------------------
// /api/mpi/recall
// ---------------------------------------------------------------------------

export interface RecallRequest {
  /** Query embedding vector (must match embed_dim, e.g. 384-dim) */
  embedding: number[];
  /** Embedding model identifier (must match remember-time model) */
  embedding_model: string;
  /** Maximum number of memories to return (default: 10) */
  top_k: number;
  /** Max token budget for returned memories (default: 2000) */
  token_budget?: number;
  /** Session ID for φ₇ session coherence scoring */
  session_id?: string;
}

export interface RecallResponse {
  /** Ranked list of memories (Identity always first) */
  memories: Memory[];
  /** Total candidates considered before top_k filtering */
  total_candidates: number;
  /** Estimated token count of all returned memories */
  token_estimate: number;
}

// ---------------------------------------------------------------------------
// /api/mpi/remember
// ---------------------------------------------------------------------------

export interface RememberRequest {
  /** Third-person summary of the information to store */
  content: string;
  /** Target cognitive layer */
  layer: MemoryLayer;
  /** Semantic tags for categorization */
  topic_tags?: string[];
  /** Identifier of the AI system storing this memory */
  source_ai: string;
  /** Embedding vector of the content */
  embedding: number[];
  /** Embedding model identifier (must be consistent with recall) */
  embedding_model: string;
}

export interface RememberResponse {
  /** Deterministic record ID */
  record_id: string;
  /** "created" or "duplicate" */
  status: "created" | "duplicate";
  /** If duplicate, the ID of the existing record */
  duplicate_of: string | null;
}

// ---------------------------------------------------------------------------
// /api/mpi/forget
// ---------------------------------------------------------------------------

export interface ForgetRequest {
  /** Record ID to permanently delete */
  record_id: string;
}

export interface ForgetResponse {
  /** "revoked" on success */
  status: "revoked" | "not_found";
}

// ---------------------------------------------------------------------------
// /api/mpi/log
// ---------------------------------------------------------------------------

export interface LogTurn {
  /** "user" or "assistant" */
  role: string;
  /** Message content */
  content: string;
}

export interface LogRequest {
  /** Session identifier (consistent within one conversation) */
  session_id: string;
  /** Conversation turns to log */
  turns: LogTurn[];
  /** Identifier of the AI system sending this log */
  source_ai: string;
  /**
   * JSON-serialized recall context from the recall response.
   * Used for negative feedback detection — when user says "wrong",
   * the rule engine needs to know WHICH memory was wrong.
   * Format: [{"id":"xxx","score":1.3,"features":[]}]
   */
  recall_context?: string;
}

export interface LogResponse {
  /** Number of turns logged */
  logged: number;
  /** Session ID echoed back */
  session_id: string;
}

// ---------------------------------------------------------------------------
// /api/mpi/status
// ---------------------------------------------------------------------------

export interface StatusResponse {
  /** Whether MemChain engine is enabled */
  memchain_enabled: boolean;
  /** Whether the vector index is built and ready */
  index_ready: boolean;
  /** Whether the local embedding engine is loaded */
  embed_ready: boolean;
  /** Embedding dimensionality (e.g. 384), null if embed not ready */
  embed_dim: number | null;
  /** Schema version (expected: 4) */
  schema_version: number;
  /** Record statistics */
  stats: {
    total_records: number;
    identity_count?: number;
    knowledge_count?: number;
    episode_count?: number;
    archive_count?: number;
  };
  /** MVF scoring status */
  mvf?: {
    enabled: boolean;
    alpha: number;
    total_positive_feedback?: number;
    total_negative_feedback?: number;
  };
}

// ---------------------------------------------------------------------------
// Plugin Configuration (used in config.ts schema)
// ---------------------------------------------------------------------------

export interface MemChainPluginConfig {
  /** Operating mode: "local" (Bearer token + localhost) or "remote" (Ed25519 + E2E encryption) */
  mode: "local" | "remote";
  /** MemChain MPI endpoint URL for local mode (default: "http://127.0.0.1:8421") */
  memchainUrl: string;
  /** Remote MemChain node URL. Only used in remote mode. */
  nodeUrl: string;
  /** Path to Ed25519 key pair file (default: "~/.openclaw/memchain-keys.json") */
  keyStorePath: string;
  /** Embedding model identifier (default: "minilm-l6-v2") */
  embeddingModel: string;
  /** Source AI identifier for remember/log calls (default: "openclaw-memchain") */
  sourceAi: string;
  /** Max tokens for recall context injection (default: 2000) */
  tokenBudget: number;
  /** Max memories to recall per turn (default: 10) */
  recallTopK: number;
  /** HTTP request timeout in ms (default: 5000) */
  timeout: number;
  /** Auto-recall on every message (default: true) */
  enableAutoRecall: boolean;
  /** Auto-log turns on session end (default: true) */
  enableAutoLog: boolean;
}
