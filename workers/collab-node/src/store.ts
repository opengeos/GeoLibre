import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeMode, parseStoredChat } from "@geolibre/collab-core";
import type { CollabChatMessage, CollaborationMode } from "@geolibre/collab-core";

export interface StoredSession {
  id: string;
  hostToken: string;
  mode: CollaborationMode;
  rev: number;
  snapshot: unknown | null;
  chat: CollabChatMessage[];
  updatedAt: number;
}

interface SessionRow {
  id: string;
  host_token: string;
  mode: string;
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
        rev INTEGER NOT NULL DEFAULT 0,
        snapshot TEXT,
        chat TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
    `);
  }

  create(id: string, hostToken: string, mode: CollaborationMode): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO collab_sessions
          (id, host_token, mode, rev, snapshot, chat, updated_at)
         VALUES (?, ?, ?, 0, NULL, '[]', ?)`,
      )
      .run(id, hostToken, mode, Date.now());
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
      // normalizeMode rather than an inline ternary: if the shared contract
      // gains a third mode, this would silently downgrade it to co-edit while
      // the relay accepted it on the wire.
      mode: normalizeMode(row.mode),
      rev: row.rev,
      snapshot: parseJson(row.snapshot, null),
      // Shape-checked per entry, not just JSON-parsed: a corrupt or tampered
      // chat column would otherwise reach joiners in `welcome` and crash a
      // client on `coordinate.lat.toFixed`. Same guard the Worker applies.
      chat: parseStoredChat(row.chat),
      updatedAt: row.updated_at,
    };
  }

  saveSnapshot(id: string, project: unknown): number {
    // RETURNING keeps the write and the revision read in one statement, so the
    // number handed back is always the one this update produced.
    const row = this.db
      .prepare(
        `UPDATE collab_sessions
         SET snapshot = ?, rev = rev + 1, updated_at = ?
         WHERE id = ?
         RETURNING rev`,
      )
      .get(JSON.stringify(project), Date.now(), id) as { rev: number } | undefined;
    return row?.rev ?? 0;
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

  saveChat(id: string, chat: CollabChatMessage[]): void {
    this.db
      .prepare("UPDATE collab_sessions SET chat = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(chat), Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM collab_sessions WHERE id = ?").run(id);
  }

  /**
   * Drop sessions untouched since `cutoff`, skipping any that are currently live
   * in memory. Reclaims codes that were allocated by `POST /sessions` but never
   * joined, which no socket-close path ever reaches.
   */
  deleteStaleBefore(cutoff: number, keep: Iterable<string>): void {
    const keepSet = new Set(keep);
    const rows = this.db
      .prepare("SELECT id FROM collab_sessions WHERE updated_at < ?")
      .all(cutoff) as { id: string }[];
    const remove = this.db.prepare("DELETE FROM collab_sessions WHERE id = ?");
    for (const row of rows) if (!keepSet.has(row.id)) remove.run(row.id);
  }

  close(): void {
    this.db.close();
  }
}
