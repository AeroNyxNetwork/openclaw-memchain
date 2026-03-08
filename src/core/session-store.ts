/**
 * ============================================
 * File: src/core/session-store.ts
 * ============================================
 * Creation Reason: Track per-session state in memory during a conversation.
 *   MemChain's /log endpoint needs the full conversation turns and the
 *   recall_context from the last recall. This store collects that data
 *   across hook invocations within the same session.
 *
 * Main Functionality:
 *   - Create/retrieve session IDs (mapped from OpenClaw sessionKey)
 *   - Collect conversation turns (user + assistant messages)
 *   - Store recall_context from the latest recall response
 *   - Auto-cleanup stale sessions (TTL-based eviction)
 *   - Clear session data after /log submission
 *
 * Dependencies:
 *   - src/types/memchain.ts (Memory, LogTurn types)
 *   - Referenced by: hooks/recall-hook.ts, hooks/log-hook.ts
 *
 * ⚠️ Important Note for Next Developer:
 *   - This is purely in-memory — data is lost on gateway restart
 *   - That's intentional: /log is the durable store, this is transient
 *   - Do NOT persist this to disk — it would duplicate MemChain's role
 *
 * Last Modified: v0.1.0-fix1 — Fixed: added export keyword to class
 * ============================================
 */

import type { Memory, LogTurn } from "../types/memchain.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_TURNS_PER_SESSION = 200;

// ---------------------------------------------------------------------------
// Session Entry
// ---------------------------------------------------------------------------

interface SessionEntry {
  sessionId: string;
  turns: LogTurn[];
  recallContext: Memory[] | null;
  lastActivity: number;
}

// ---------------------------------------------------------------------------
// Session Store
// ---------------------------------------------------------------------------

export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.evictStale(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  // -------------------------------------------------------------------------
  // Session ID management
  // -------------------------------------------------------------------------

  getOrCreateSessionId(sessionKey: string): string {
    const entry = this.sessions.get(sessionKey);
    if (entry) {
      entry.lastActivity = Date.now();
      return entry.sessionId;
    }
    const newEntry: SessionEntry = {
      sessionId: this.generateSessionId(),
      turns: [],
      recallContext: null,
      lastActivity: Date.now(),
    };
    this.sessions.set(sessionKey, newEntry);
    return newEntry.sessionId;
  }

  getSessionId(sessionKey: string): string | undefined {
    return this.sessions.get(sessionKey)?.sessionId;
  }

  // -------------------------------------------------------------------------
  // Turn collection
  // -------------------------------------------------------------------------

  addTurn(sessionKey: string, turn: LogTurn): void {
    const entry = this.getOrCreateEntry(sessionKey);
    entry.lastActivity = Date.now();
    if (entry.turns.length >= MAX_TURNS_PER_SESSION) {
      entry.turns.shift();
    }
    entry.turns.push(turn);
  }

  getTurns(sessionKey: string): LogTurn[] {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return [];
    return [...entry.turns];
  }

  // -------------------------------------------------------------------------
  // Recall context management
  // -------------------------------------------------------------------------

  setRecallContext(sessionKey: string, memories: Memory[]): void {
    const entry = this.getOrCreateEntry(sessionKey);
    entry.recallContext = memories;
    entry.lastActivity = Date.now();
  }

  getRecallContext(sessionKey: string): Memory[] | null {
    return this.sessions.get(sessionKey)?.recallContext ?? null;
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  clear(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  get size(): number {
    return this.sessions.size;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getOrCreateEntry(sessionKey: string): SessionEntry {
    let entry = this.sessions.get(sessionKey);
    if (!entry) {
      entry = {
        sessionId: this.generateSessionId(),
        turns: [],
        recallContext: null,
        lastActivity: Date.now(),
      };
      this.sessions.set(sessionKey, entry);
    }
    return entry;
  }

  private generateSessionId(): string {
    const ts = Date.now().toString(16);
    const rand = Math.random().toString(16).slice(2, 10);
    return `oc-${ts}-${rand}`;
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [key, entry] of this.sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        this.sessions.delete(key);
      }
    }
  }
}
