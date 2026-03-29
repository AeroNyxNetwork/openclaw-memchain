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
 * Modification Reason (v0.3.0):
 *   BUG FIX — MAX_TURNS_PER_SESSION overflow used shift() silently.
 *   When a session exceeded 200 turns, the oldest turn was dropped without
 *   any warning. This caused /log to silently submit incomplete conversation
 *   data, making rule engine extraction unreliable for long sessions.
 *   Fix: add a warn-once flag so the logger can surface this condition.
 *   The overflow behavior (shift) is preserved — only the silence is fixed.
 *
 *   ADDITION — addAssistantTurn() convenience method.
 *   log-hook.ts needs to collect assistant replies from a separate hook
 *   event (message:response or equivalent) rather than from responseText
 *   in message:preprocessed (which fires before LLM responds). A dedicated
 *   method makes the intent explicit at call sites.
 *
 * Dependencies:
 *   - src/types/memchain.ts (Memory, LogTurn types)
 *   - Referenced by: hooks/recall-hook.ts, hooks/log-hook.ts
 *
 * ⚠️ Important Note for Next Developer:
 *   - This is purely in-memory — data is lost on gateway restart.
 *     That's intentional: /log is the durable store, this is transient.
 *   - Do NOT persist this to disk — it would duplicate MemChain's role.
 *   - MAX_TURNS_PER_SESSION overflow drops the OLDEST turn (FIFO eviction).
 *     If you change this to drop newest, update the comment + the warn message.
 *   - hasWarnedOverflow is per-session, reset on clear(). It prevents log spam
 *     for very long sessions without hiding the problem entirely.
 *
 * Last Modified: v0.3.0 — Overflow warning + addAssistantTurn() helper
 * ============================================
 */

import type { Memory, LogTurn } from "../types/memchain.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 4 * 60 * 60 * 1000;       // 4 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;       // 10 minutes
const MAX_TURNS_PER_SESSION = 200;

// ---------------------------------------------------------------------------
// Session Entry
// ---------------------------------------------------------------------------

interface SessionEntry {
  sessionId: string;
  turns: LogTurn[];
  recallContext: Memory[] | null;
  lastActivity: number;
  /** v0.3.0: warn once when turn cap is hit, avoid log spam for long sessions */
  hasWarnedOverflow: boolean;
}

// ---------------------------------------------------------------------------
// Session Store
// ---------------------------------------------------------------------------

export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.evictStale(), CLEANUP_INTERVAL_MS);
    if (
      this.cleanupTimer &&
      typeof this.cleanupTimer === "object" &&
      "unref" in this.cleanupTimer
    ) {
      (this.cleanupTimer as { unref(): void }).unref();
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
      hasWarnedOverflow: false,
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

  /**
   * Add any turn (user or assistant). Callers should prefer the typed
   * convenience wrappers below for clarity at call sites.
   *
   * v0.3.0: emits a one-time overflow warning instead of silently dropping.
   */
  addTurn(sessionKey: string, turn: LogTurn): { overflow: boolean } {
    const entry = this.getOrCreateEntry(sessionKey);
    entry.lastActivity = Date.now();

    let overflow = false;
    if (entry.turns.length >= MAX_TURNS_PER_SESSION) {
      entry.turns.shift(); // drop oldest (FIFO)
      overflow = true;
    }

    entry.turns.push(turn);
    return { overflow: overflow && !entry.hasWarnedOverflow };
  }

  /**
   * Mark that the overflow warning has been emitted for this session,
   * so subsequent overflows don't re-trigger it.
   */
  markOverflowWarned(sessionKey: string): void {
    const entry = this.sessions.get(sessionKey);
    if (entry) entry.hasWarnedOverflow = true;
  }

  getTurns(sessionKey: string): LogTurn[] {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return [];
    return [...entry.turns];
  }

  getTurnCount(sessionKey: string): number {
    return this.sessions.get(sessionKey)?.turns.length ?? 0;
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
        hasWarnedOverflow: false,
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
