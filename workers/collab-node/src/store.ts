import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeMode, parseStoredChat } from "@geolibre/collab-core";
import type { CollabChatMessage, CollabInvite, CollaborationMode } from "@geolibre/collab-core";

export interface StoredSession {
  id: string;
  hostToken: string;
  mode: CollaborationMode;
  requireIdentity: boolean;
  lockedLayerIds: string[];
  rev: number;
  snapshot: unknown | null;
  chat: CollabChatMessage[];
  updatedAt: number;
}

interface SessionRow {
  id: string;
  host_token: string;
  mode: string;
  require_identity?: number;
  locked_layer_ids?: string;
  rev: number;
  snapshot: string | null;
  chat: string;
  updated_at: number;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS collab_sessions (
        id TEXT PRIMARY KEY,
        host_token TEXT NOT NULL,
        mode TEXT NOT NULL,
        require_identity INTEGER NOT NULL DEFAULT 0,
        locked_layer_ids TEXT NOT NULL DEFAULT '[]',
        rev INTEGER NOT NULL DEFAULT 0,
        snapshot TEXT,
        chat TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collab_invites (
        session_id TEXT NOT NULL,
        token TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        max_uses INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, token)
      );
      CREATE INDEX IF NOT EXISTS idx_collab_invites_session_id ON collab_invites(session_id);
      CREATE TABLE IF NOT EXISTS collab_durable_overrides (
        session_id TEXT NOT NULL,
        participant_key TEXT NOT NULL,
        edit_override INTEGER NOT NULL,
        PRIMARY KEY (session_id, participant_key)
      );
      CREATE TABLE IF NOT EXISTS collab_blocked_keys (
        session_id TEXT NOT NULL,
        participant_key TEXT NOT NULL,
        blocked_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, participant_key)
      );
    `);

    // Schema migrations for existing databases created before these columns existed
    const columns = (
      this.db.prepare("PRAGMA table_info(collab_sessions)").all() as { name: string }[]
    ).map((c) => c.name);
    if (!columns.includes("require_identity")) {
      this.db.exec(
        "ALTER TABLE collab_sessions ADD COLUMN require_identity INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.includes("locked_layer_ids")) {
      this.db.exec(
        "ALTER TABLE collab_sessions ADD COLUMN locked_layer_ids TEXT NOT NULL DEFAULT '[]'",
      );
    }
    if (!columns.includes("rev")) {
      this.db.exec("ALTER TABLE collab_sessions ADD COLUMN rev INTEGER NOT NULL DEFAULT 0");
    }
  }

  create(id: string, hostToken: string, mode: CollaborationMode, requireIdentity = false): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO collab_sessions
          (id, host_token, mode, require_identity, locked_layer_ids, rev, snapshot, chat, updated_at)
         VALUES (?, ?, ?, ?, '[]', 0, NULL, '[]', ?)`,
      )
      .run(id, hostToken, mode, requireIdentity ? 1 : 0, Date.now());
    return result.changes === 1;
  }

  get(id: string): StoredSession | null {
    const row = this.db.prepare("SELECT * FROM collab_sessions WHERE id = ?").get(id) as unknown as
      | SessionRow
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      hostToken: row.host_token,
      mode: normalizeMode(row.mode),
      requireIdentity: row.require_identity === 1,
      lockedLayerIds: parseJson<string[]>(row.locked_layer_ids ?? null, []),
      rev: row.rev ?? 0,
      snapshot: parseJson<unknown | null>(row.snapshot, null),
      chat: parseStoredChat(row.chat),
      updatedAt: row.updated_at,
    };
  }

  saveSnapshot(id: string, snapshot: unknown, rev: number): void {
    this.db
      .prepare("UPDATE collab_sessions SET snapshot = ?, rev = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(snapshot), rev, Date.now(), id);
  }

  saveProjectState(id: string, project: unknown): void {
    this.db
      .prepare("UPDATE collab_sessions SET snapshot = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(project), Date.now(), id);
  }

  saveMode(id: string, mode: CollaborationMode): void {
    this.db
      .prepare("UPDATE collab_sessions SET mode = ?, updated_at = ? WHERE id = ?")
      .run(mode, Date.now(), id);
  }

  saveSessionConfig(id: string, requireIdentity?: boolean): void {
    if (requireIdentity !== undefined) {
      this.db
        .prepare("UPDATE collab_sessions SET require_identity = ?, updated_at = ? WHERE id = ?")
        .run(requireIdentity ? 1 : 0, Date.now(), id);
    }
  }

  saveLayerLocks(id: string, lockedLayerIds: string[]): void {
    this.db
      .prepare("UPDATE collab_sessions SET locked_layer_ids = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(lockedLayerIds), Date.now(), id);
  }

  saveChat(id: string, chat: CollabChatMessage[]): void {
    this.db
      .prepare("UPDATE collab_sessions SET chat = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(chat), Date.now(), id);
  }

  saveInvite(sessionId: string, invite: CollabInvite): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO collab_invites (session_id, token, role, created_at, max_uses, use_count, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        invite.token,
        invite.role,
        invite.createdAt,
        invite.maxUses ?? null,
        invite.useCount,
        invite.revoked ? 1 : 0,
      );
  }

  /**
   * Atomically increment an invite's use_count, succeeding only if the invite
   * is not revoked and has not exceeded its maxUses cap. Returns true if the
   * claim succeeded. This closes a TOCTOU window where two near-simultaneous
   * joins could both read use_count < max_uses before either writes.
   */
  atomicClaimInvite(sessionId: string, token: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE collab_invites
         SET use_count = use_count + 1
         WHERE session_id = ? AND token = ? AND revoked = 0
           AND (max_uses IS NULL OR use_count < max_uses)`,
      )
      .run(sessionId, token);
    return result.changes === 1;
  }

  createInvite(sessionId: string, invite: CollabInvite): void {
    this.saveInvite(sessionId, invite);
  }

  getInvites(sessionId: string): CollabInvite[] {
    const rows = this.db
      .prepare("SELECT * FROM collab_invites WHERE session_id = ? ORDER BY created_at DESC")
      .all(sessionId) as unknown as {
      token: string;
      role: string;
      created_at: number;
      max_uses: number | null;
      use_count: number;
      revoked: number;
    }[];
    return rows.map((r) => ({
      token: r.token,
      role: r.role === "view-only" ? "view-only" : "co-edit",
      createdAt: r.created_at,
      ...(r.max_uses !== null ? { maxUses: r.max_uses } : {}),
      useCount: r.use_count,
      revoked: r.revoked === 1,
    }));
  }

  revokeInvite(sessionId: string, token: string): void {
    this.db
      .prepare("UPDATE collab_invites SET revoked = 1 WHERE session_id = ? AND token = ?")
      .run(sessionId, token);
  }

  getDurableOverride(sessionId: string, participantKey: string | null): boolean | undefined {
    if (!participantKey) return undefined;
    const row = this.db
      .prepare(
        "SELECT edit_override FROM collab_durable_overrides WHERE session_id = ? AND participant_key = ?",
      )
      .get(sessionId, participantKey) as { edit_override: number } | undefined;
    return row ? row.edit_override === 1 : undefined;
  }

  saveDurableOverride(
    sessionId: string,
    participantKey: string | null,
    canEdit: boolean | undefined,
  ): void {
    if (!participantKey) return;
    if (canEdit === undefined) {
      this.db
        .prepare(
          "DELETE FROM collab_durable_overrides WHERE session_id = ? AND participant_key = ?",
        )
        .run(sessionId, participantKey);
    } else {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO collab_durable_overrides (session_id, participant_key, edit_override) VALUES (?, ?, ?)",
        )
        .run(sessionId, participantKey, canEdit ? 1 : 0);
    }
  }

  clearDurableOverrides(sessionId: string): void {
    this.db.prepare("DELETE FROM collab_durable_overrides WHERE session_id = ?").run(sessionId);
  }

  isBlockedKey(sessionId: string, participantKey: string | null): boolean {
    if (!participantKey) return false;
    const row = this.db
      .prepare(
        "SELECT participant_key FROM collab_blocked_keys WHERE session_id = ? AND participant_key = ?",
      )
      .get(sessionId, participantKey);
    return row !== undefined;
  }

  blockKey(sessionId: string, participantKey: string | null): void {
    if (!participantKey) return;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO collab_blocked_keys (session_id, participant_key, blocked_at) VALUES (?, ?, ?)",
      )
      .run(sessionId, participantKey, Date.now());
  }

  delete(id: string): void {
    this.db.exec("BEGIN TRANSACTION");
    try {
      this.db.prepare("DELETE FROM collab_sessions WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM collab_invites WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM collab_durable_overrides WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM collab_blocked_keys WHERE session_id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  deleteStaleBefore(cutoff: number, keep: Iterable<string>): void {
    const keepSet = new Set(keep);
    const rows = this.db
      .prepare("SELECT id FROM collab_sessions WHERE updated_at < ?")
      .all(cutoff) as { id: string }[];
    this.db.exec("BEGIN TRANSACTION");
    try {
      for (const row of rows) {
        if (!keepSet.has(row.id)) {
          this.db.prepare("DELETE FROM collab_sessions WHERE id = ?").run(row.id);
          this.db.prepare("DELETE FROM collab_invites WHERE session_id = ?").run(row.id);
          this.db.prepare("DELETE FROM collab_durable_overrides WHERE session_id = ?").run(row.id);
          this.db.prepare("DELETE FROM collab_blocked_keys WHERE session_id = ?").run(row.id);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
