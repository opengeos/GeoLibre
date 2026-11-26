import { DurableObject } from "cloudflare:workers";
import type {
  CollabInvite,
  CollabParticipant,
  ClientMessage,
  CollaborationMode,
  PresenceEntry,
  ServerMessage,
  SessionLogEntry,
} from "./protocol";
import {
  isBoundedId,
  MAX_COMMENTS_PER_SESSION,
  MAX_REPLIES_PER_COMMENT,
  MIN_COMMENT_INTERVAL_MS,
  preserveStoredComments,
  validateComment,
  validateReply,
} from "./comment-validate";
import {
  appendBoundedChatHistory,
  authorizeHostAction,
  authorizeSnapshot,
  RELAY_SNAPSHOT_ORIGIN,
  resolveJoin,
  shouldResyncRejectedSnapshot,
  clearParticipantOverrides,
  EMPTY_SESSION_TTL_MS,
  getParticipantKey,
  isIdentityConfigured,
  MAX_SESSION_LOG_STORAGE_BYTES,
  MAX_SNAPSHOT_BYTES,
  parseStoredChat,
  prepareChatMessage,
  normalizeMode,
  participantCanEdit,
  sanitizeCursor,
  SESSION_LOG_LIMIT,
  sanitizeView,
  setParticipantOverride,
  timingSafeEqual,
  toWireParticipant,
  type SessionParticipant,
  CRDT_FEATURE,
} from "@geolibre/collab-core";
import {
  chunkBytes,
  docUpdateMessages,
  joinBytes,
  MAX_DOC_BYTES,
  RelayDoc,
  type DocStorage,
} from "@geolibre/collab-core/crdt-relay";

/** Parse the stored snapshot defensively: a corrupt value yields null rather
 *  than throwing (which would lock joiners out of the session). */
function parseStoredSnapshot(snapshot: string | undefined): unknown {
  if (!snapshot) return null;
  try {
    return JSON.parse(snapshot);
  } catch {
    return null;
  }
}

function tooLargeError(): ServerMessage {
  return {
    type: "error",
    code: "too-large",
    message: "Project is too large to sync live. Share it via URL instead.",
  };
}

export interface Env {
  COLLAB_SESSION: DurableObjectNamespace<CollabSession>;
  /** Optional deployment-specific snapshot ceiling, expressed in bytes. */
  COLLAB_MAX_SNAPSHOT_BYTES?: string;
  /** Optional ceiling on a session's op-level document, in bytes. */
  COLLAB_MAX_DOC_BYTES?: string;
  /** Optional allowed origins list for session creation. */
  ALLOWED_ORIGINS?: string;
  /**
   * HMAC-SHA256 secret shared with this deployment's identity issuer. Unset
   * (the default) disables identity entirely: `identityToken` is ignored, every
   * joiner is anonymous, and "require a signed-in account" cannot be turned on.
   * Set it with `wrangler secret put COLLAB_IDENTITY_SECRET`.
   */
  COLLAB_IDENTITY_SECRET?: string;
  /** Cloudflare Rate Limiting binding required for `POST /sessions`. */
  COLLAB_RATE_LIMITER: RateLimit;
}

// The snapshot cap, empty-session TTL, and chat limits now live in
// `@geolibre/collab-core` (imported above) so both relays enforce one set of
// numbers; see that module for why each value is what it is.

// Stateless and reused across frames (snapshots can arrive several times a
// second), so we don't allocate a new encoder per message.
const ENCODER = new TextEncoder();

function parseStoredSessionLog(raw: unknown): SessionLogEntry[] {
  // Accept either the JSON string this code writes or a bare array, so a
  // value persisted in another shape is kept rather than silently discarded.
  if (Array.isArray(raw)) return raw as SessionLogEntry[];
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SessionLogEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * The shared `SessionParticipant` state, serialized onto a hibernatable socket.
 * `editOverride`, `lastChatTs`, and `lastCommentTs` ride on the attachment so
 * they survive a hibernation wake; none is persisted to storage, because each is
 * keyed to a per-socket clientId (#754, Part 3).
 *
 * Deliberately an alias rather than an interface restating the fields: a copy
 * would compile fine while silently reintroducing the drift the extraction into
 * `@geolibre/collab-core` exists to prevent.
 */
type SocketAttachment = SessionParticipant;

type PresenceState = PresenceEntry;

/**
 * One live collaboration session. All participants of a given session code land
 * on the same instance (addressed by `idFromName(code)`), so the actor can fan
 * messages out to every connected socket.
 *
 * Durable storage holds the latest project snapshot, a monotonic revision, the
 * session mode, and the host token — everything a late joiner needs after the
 * actor has hibernated. Presence (cursors/viewports) is in-memory only and is
 * naturally re-established as participants move.
 */
export class CollabSession extends DurableObject<Env> {
  // Re-established lazily after a hibernation wake; never persisted.
  private presence = new Map<string, PresenceState>();
  // Tracks sockets currently awaiting `resolveJoin` so a second `join` frame
  // cannot race through the duplicate-join guard while identity is verifying.
  private joiningSockets = new WeakSet<WebSocket>();

  // The session's authoritative Yjs document, loaded on first use after each
  // wake (see `relayDocument`). `rev` mirrors the stored counter while it is.
  private relayDoc: RelayDoc | null = null;
  private rev = 0;

  private maxDocBytes(): number {
    const configured = Number(this.env.COLLAB_MAX_DOC_BYTES);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : MAX_DOC_BYTES;
  }

  /**
   * Row-chunked document storage in this object's SQLite database: a base
   * state plus an append-only log of the updates since, each split into
   * values under the 2 MB SQLite cap.
   */
  private docStorage(): DocStorage {
    const sql = this.ctx.storage.sql;
    return {
      load: () => {
        this.ensureTables();
        const base = sql
          .exec<{ value: ArrayBuffer }>("SELECT value FROM collab_doc_base ORDER BY seq")
          .toArray()
          .map((row) => new Uint8Array(row.value));
        const log = new Map<number, Uint8Array[]>();
        for (const row of sql
          .exec<{
            entry: number;
            value: ArrayBuffer;
          }>("SELECT entry, value FROM collab_doc_log ORDER BY entry, part")
          .toArray()) {
          const parts = log.get(row.entry) ?? [];
          parts.push(new Uint8Array(row.value));
          log.set(row.entry, parts);
        }
        return {
          base: base.length ? joinBytes(base) : null,
          log: Array.from(log.values(), (parts) => joinBytes(parts)),
        };
      },
      append: (update) => {
        this.ensureTables();
        // One transaction, so a failure cannot leave a partial entry that
        // would break every later load.
        this.ctx.storage.transactionSync(() => {
          const next =
            sql
              .exec<{ entry: number | null }>("SELECT MAX(entry) AS entry FROM collab_doc_log")
              .toArray()[0]?.entry ?? -1;
          chunkBytes(update).forEach((part, index) => {
            sql.exec(
              "INSERT INTO collab_doc_log (entry, part, value) VALUES (?, ?, ?)",
              next + 1,
              index,
              part.slice().buffer,
            );
          });
        });
      },
      replace: (base) => {
        this.ensureTables();
        this.ctx.storage.transactionSync(() => {
          sql.exec("DELETE FROM collab_doc_base");
          sql.exec("DELETE FROM collab_doc_log");
          chunkBytes(base).forEach((part, index) => {
            sql.exec(
              "INSERT INTO collab_doc_base (seq, value) VALUES (?, ?)",
              index,
              part.slice().buffer,
            );
          });
        });
      },
    };
  }

  /**
   * The session document, opened (and, for a session that predates op-level
   * sync, migrated from its stored snapshot) on first use.
   */
  private async relayDocument(): Promise<RelayDoc> {
    if (this.relayDoc) return this.relayDoc;
    this.ensureTables();
    const hasDoc =
      this.ctx.storage.sql
        .exec<{ n: number }>(
          "SELECT (SELECT COUNT(*) FROM collab_doc_base) + (SELECT COUNT(*) FROM collab_doc_log) AS n",
        )
        .toArray()[0].n > 0;
    const legacy = hasDoc ? null : parseStoredSnapshot(await this.readSnapshot());
    this.rev = (await this.ctx.storage.get<number>("rev")) ?? 0;
    // Another frame may have opened it while this one awaited.
    if (this.relayDoc) return this.relayDoc;
    this.relayDoc = new RelayDoc({
      storage: this.docStorage(),
      maxDocBytes: this.maxDocBytes(),
      legacySnapshot: () => legacy,
      onMigrated: () => {
        this.ctx.storage.sql.exec("DELETE FROM collab_snapshot_chunks");
        void this.ctx.storage.delete("snapshot");
      },
      onUpdate: (update, origin) => this.fanOutDocUpdate(update, origin),
    });
    return this.relayDoc;
  }

  /**
   * Send one accepted document change to every other participant: as
   * `doc-update` frames to op-level clients, and as a whole `snapshot` to
   * clients still on the snapshot protocol.
   */
  private fanOutDocUpdate(update: Uint8Array, origin: string): void {
    this.rev += 1;
    const rev = this.rev;
    void this.ctx.storage.put("rev", rev);
    void this.appendLog({ type: "snapshot", ts: Date.now(), rev, origin });
    // Built on first use: a session may have no op-level (or no snapshot) peer.
    let frames: string[] | undefined;
    let snapshotPayload: string | null | undefined;
    for (const { socket, attachment } of this.attachedSockets()) {
      if (attachment.clientId === origin) continue;
      try {
        if (attachment.crdt) {
          frames ??= docUpdateMessages(update, origin, rev, () => crypto.randomUUID()).map((m) =>
            JSON.stringify(m),
          );
          for (const frame of frames) socket.send(frame);
          continue;
        }
        if (snapshotPayload === undefined) {
          const payload = JSON.stringify({
            type: "snapshot",
            project: this.relayDoc!.materialize(),
            origin,
            rev,
          } satisfies ServerMessage);
          snapshotPayload =
            ENCODER.encode(payload).length > this.maxSnapshotBytes() ? null : payload;
        }
        if (snapshotPayload) {
          socket.send(snapshotPayload);
        } else if (!attachment.snapshotWithheld) {
          // This peer no longer holds the session's project; refuse its
          // snapshots from now on (see handleSnapshot).
          attachment.snapshotWithheld = true;
          socket.serializeAttachment(attachment);
          this.send(socket, tooLargeError());
        }
      } catch {
        // A dead socket; its close handler reconciles.
      }
    }
  }

  private maxSnapshotBytes(): number {
    const configured = Number(this.env.COLLAB_MAX_SNAPSHOT_BYTES);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : MAX_SNAPSHOT_BYTES;
  }

  private ensureTables(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS collab_snapshot_chunks (seq INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS collab_doc_base (seq INTEGER PRIMARY KEY, value BLOB NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS collab_doc_log (entry INTEGER NOT NULL, part INTEGER NOT NULL, value BLOB NOT NULL, PRIMARY KEY (entry, part))",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS collab_invites (token TEXT PRIMARY KEY, role TEXT NOT NULL, created_at INTEGER NOT NULL, max_uses INTEGER, use_count INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS collab_durable_overrides (participant_key TEXT PRIMARY KEY, edit_override INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS collab_blocked_keys (participant_key TEXT PRIMARY KEY, blocked_at INTEGER NOT NULL)",
    );
  }

  private readDurableOverride(participantKey: string | null): boolean | undefined {
    if (!participantKey) return undefined;
    this.ensureTables();
    const rows = this.ctx.storage.sql
      .exec<{ edit_override: number }>(
        "SELECT edit_override FROM collab_durable_overrides WHERE participant_key = ?",
        participantKey,
      )
      .toArray();
    return rows.length > 0 ? rows[0].edit_override === 1 : undefined;
  }

  private writeDurableOverride(
    participantKey: string | null,
    editOverride: boolean | undefined,
  ): void {
    if (!participantKey) return;
    this.ensureTables();
    if (editOverride === undefined) {
      this.ctx.storage.sql.exec(
        "DELETE FROM collab_durable_overrides WHERE participant_key = ?",
        participantKey,
      );
    } else {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO collab_durable_overrides (participant_key, edit_override) VALUES (?, ?)",
        participantKey,
        editOverride ? 1 : 0,
      );
    }
  }

  private clearAllDurableOverrides(): void {
    this.ensureTables();
    this.ctx.storage.sql.exec("DELETE FROM collab_durable_overrides");
  }

  private isBlockedKey(participantKey: string | null): boolean {
    if (!participantKey) return false;
    this.ensureTables();
    const rows = this.ctx.storage.sql
      .exec<{ participant_key: string }>(
        "SELECT participant_key FROM collab_blocked_keys WHERE participant_key = ?",
        participantKey,
      )
      .toArray();
    return rows.length > 0;
  }

  private blockKey(participantKey: string | null): void {
    if (!participantKey) return;
    this.ensureTables();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO collab_blocked_keys (participant_key, blocked_at) VALUES (?, ?)",
      participantKey,
      Date.now(),
    );
  }

  private readInvites(): CollabInvite[] {
    this.ensureTables();
    const rows = this.ctx.storage.sql
      .exec<{
        token: string;
        role: string;
        created_at: number;
        max_uses: number | null;
        use_count: number;
        revoked: number;
      }>(
        "SELECT token, role, created_at, max_uses, use_count, revoked FROM collab_invites ORDER BY created_at DESC",
      )
      .toArray();
    return rows.map((r) => ({
      token: r.token,
      role: r.role === "view-only" ? "view-only" : "co-edit",
      createdAt: r.created_at,
      ...(r.max_uses !== null ? { maxUses: r.max_uses } : {}),
      useCount: r.use_count,
      revoked: r.revoked === 1,
    }));
  }

  private writeInvite(invite: CollabInvite): void {
    this.ensureTables();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO collab_invites (token, role, created_at, max_uses, use_count, revoked) VALUES (?, ?, ?, ?, ?, ?)",
      invite.token,
      invite.role,
      invite.createdAt,
      invite.maxUses ?? null,
      invite.useCount,
      invite.revoked ? 1 : 0,
    );
  }

  private revokeInviteToken(token: string): boolean {
    this.ensureTables();
    this.ctx.storage.sql.exec("UPDATE collab_invites SET revoked = 1 WHERE token = ?", token);
    return true;
  }

  /**
   * Read a whole-project snapshot stored before op-level sync, reassembled
   * from its chunks. Only `relayDocument` reads it, to migrate the session into
   * a document; the migration then deletes it.
   *
   * Falls back to the older `snapshot` key/value entry so a session created
   * before the chunk table existed migrates too.
   */
  private readSqlSnapshot(): string | undefined {
    this.ensureTables();
    // Not `.one()`: that throws unless the result set holds exactly one row,
    // so a session that has not stored a snapshot yet would fail instead of
    // falling through to the legacy KV read below.
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM collab_snapshot_chunks ORDER BY seq")
      .toArray();
    return rows.length > 0 ? rows.map((row) => row.value).join("") : undefined;
  }

  private async readSnapshot(): Promise<string | undefined> {
    const sqlSnapshot = this.readSqlSnapshot();
    if (sqlSnapshot !== undefined) return sqlSnapshot;
    return this.ctx.storage.get<string>("snapshot");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal init from the router: record the mode and host token before the
    // host's socket connects. Only the first call wins so a guest can't reset an
    // existing session by guessing its code.
    if (url.pathname === "/init" && request.method === "POST") {
      const existing = await this.ctx.storage.get<string>("hostToken");
      // Express the real intent — "already initialized" — as "a value is
      // present", not "the value is truthy", so a stored empty token wouldn't
      // be treated as uninitialized and let a later /init overwrite it.
      if (existing !== undefined) {
        return Response.json({ ok: true, alreadyInitialized: true });
      }
      const body = (await request.json()) as {
        mode?: CollaborationMode;
        hostToken?: string;
        requireIdentity?: boolean;
      };
      const mode: CollaborationMode = body.mode === "view-only" ? "view-only" : "co-edit";
      await this.ctx.storage.put({
        mode,
        hostToken: body.hostToken ?? "",
        requireIdentity: body.requireIdentity === true,
        lockedLayerIds: [] as string[],
        rev: 0,
      });
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_SESSION_TTL_MS);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      // A session must be initialized (created via POST /sessions) before it can
      // be joined; otherwise an arbitrary code would silently create one.
      const hostToken = await this.ctx.storage.get<string>("hostToken");
      if (hostToken === undefined) {
        return new Response("Unknown session", { status: 404 });
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      // Hibernatable accept: the actor can evict from memory between messages
      // while keeping the socket open.
      this.ctx.acceptWebSocket(server);
      // A freshly accepted socket cancels any pending empty-session cleanup.
      await this.ctx.storage.deleteAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }

    // Host-only session log. The host token is a bearer credential, so it
    // travels in the Authorization header rather than the query string (which
    // lands in server logs, browser history and referrers). Both the stored and
    // the presented token must be non-empty: /init persists "" for a session
    // created without a token, and "" === "" must not grant access.
    if (url.pathname === "/log" && (request.method === "GET" || request.method === "DELETE")) {
      const hostToken = await this.ctx.storage.get<string>("hostToken");
      const authorization = request.headers.get("Authorization") ?? "";
      const clientToken = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";
      if (!hostToken || !clientToken || !timingSafeEqual(hostToken, clientToken)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (request.method === "DELETE") {
        // Owner-initiated deletion of the log alone; the session itself and
        // its snapshot are untouched.
        await this.ctx.storage.delete("sessionLog");
        return new Response(null, { status: 204 });
      }
      const log = parseStoredSessionLog(await this.ctx.storage.get<unknown>("sessionLog"));
      return new Response(JSON.stringify(log), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") {
      this.send(ws, {
        type: "error",
        code: "bad-message",
        message: "Binary frames are not supported.",
      });
      return;
    }

    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(ws, {
        type: "error",
        code: "bad-message",
        message: "Malformed JSON.",
      });
      return;
    }

    const attachment = ws.deserializeAttachment() as SocketAttachment | null;

    if (message.type === "join") {
      await this.handleJoin(ws, message);
      return;
    }

    // Every other message requires a prior join (so we know who is speaking).
    if (!attachment) {
      this.send(ws, {
        type: "error",
        code: "bad-message",
        message: "Send a join message first.",
      });
      return;
    }

    switch (message.type) {
      case "snapshot":
        // Pass the accurate UTF-8 byte length (raw.length counts UTF-16 code
        // units, which undercounts multi-byte characters).
        await this.handleSnapshot(ws, attachment, message, ENCODER.encode(raw).length);
        break;
      case "presence":
        this.handlePresence(attachment, message);
        break;
      case "set-mode":
        await this.handleSetMode(ws, attachment, message.mode);
        break;
      case "set-participant-mode":
        await this.handleSetParticipantMode(ws, attachment, message);
        break;
      case "chat":
        await this.handleChat(ws, attachment, message);
        break;
      case "comment-mutation":
        await this.handleCommentMutation(ws, attachment, message);
        break;
      case "mint-invite":
        this.handleMintInvite(ws, attachment, message);
        break;
      case "revoke-invite":
        this.handleRevokeInvite(ws, attachment, message);
        break;
      case "set-session-config":
        await this.handleSetSessionConfig(ws, attachment, message);
        break;
      case "kick-participant":
        this.handleKickParticipant(ws, attachment, message);
        break;
      case "block-participant":
        this.handleBlockParticipant(ws, attachment, message);
        break;
      case "set-layer-locks":
        await this.handleSetLayerLocks(ws, attachment, message);
        break;
      case "doc-sync":
        await this.handleDocSync(ws, attachment, message);
        break;
      case "doc-update":
        await this.handleDocUpdate(ws, attachment, message);
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment) {
      this.presence.delete(attachment.clientId);
      this.relayDoc?.forget(attachment.clientId);
      await this.appendLog({
        type: "leave",
        ts: Date.now(),
        clientId: attachment.clientId,
      });
    }
    try {
      ws.close();
    } catch {
      // Already closing; ignore.
    }
    // The closing socket can still be present in getWebSockets() during this
    // handler, so exclude it explicitly from both the participant list and the
    // empty-session check (otherwise the leaver lingers and the cleanup alarm
    // is never scheduled when the last participant leaves).
    this.broadcast({ type: "participants", participants: this.participants(ws) }, ws);
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (remaining.length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_SESSION_TTL_MS);
    }
  }

  async webSocketError(): Promise<void> {
    // Intentional no-op: Cloudflare fires webSocketClose after webSocketError,
    // so all cleanup (presence removal, participant broadcast, TTL alarm)
    // happens there once — delegating here would double-broadcast.
  }

  async alarm(): Promise<void> {
    // Only reclaim if still empty; a rejoin between scheduling and firing leaves
    // live sockets we must not orphan.
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.relayDoc = null;
      this.rev = 0;
    }
  }

  // -- handlers ---------------------------------------------------------------

  private async handleJoin(
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "join" }>,
  ): Promise<void> {
    // Ignore a duplicate join on an already-joined or currently-joining socket:
    // re-running it would mint a new clientId, orphan presence, or consume an
    // invite twice.
    if (ws.deserializeAttachment() || this.joiningSockets.has(ws)) return;
    this.joiningSockets.add(ws);
    try {
      const [storedToken, mode, chat, requireIdentity, lockedLayerIds] = await Promise.all([
        this.ctx.storage.get<string>("hostToken"),
        this.ctx.storage.get<CollaborationMode>("mode"),
        this.ctx.storage.get<string>("chat"),
        this.ctx.storage.get<boolean>("requireIdentity"),
        this.ctx.storage.get<string[]>("lockedLayerIds"),
      ]);
      const relayDoc = await this.relayDocument();

      const joined = await resolveJoin({
        message,
        storedHostToken: storedToken,
        requireIdentity: requireIdentity === true,
        identitySecret: this.env.COLLAB_IDENTITY_SECRET,
        generateClientId: () => crypto.randomUUID(),
        getInvites: () => this.readInvites(),
        isBlockedKey: (key) => this.isBlockedKey(key),
        claimInvite: (token) => {
          const freshInv = this.readInvites().find((i) => i.token === token && !i.revoked);
          if (!freshInv || (freshInv.maxUses && freshInv.useCount >= freshInv.maxUses)) {
            return null;
          }
          freshInv.useCount += 1;
          this.writeInvite(freshInv);
          return freshInv;
        },
        getDurableOverride: (key) => this.readDurableOverride(key),
        isStillConnected: () => ws.readyState === 1,
      });
      if (joined.status === "aborted") return;
      if (joined.status === "error") {
        this.send(ws, {
          type: "error",
          code: joined.code,
          message: joined.message,
        });
        return;
      }

      const { participant: attachment, identity, role } = joined;
      ws.serializeAttachment(attachment);

      await this.appendLog({
        type: "join",
        ts: Date.now(),
        clientId: attachment.clientId,
        identity,
      });

      const welcomeInvites = role === "host" ? this.readInvites() : undefined;
      // An op-level client fetches the project with `doc-sync`; a snapshot
      // client gets it inline, unless it outgrew what one frame may carry.
      let snapshot: unknown = null;
      let snapshotTooLarge = false;
      if (!attachment.crdt && !relayDoc.project.isEmpty()) {
        snapshot = relayDoc.materialize();
        if (ENCODER.encode(JSON.stringify(snapshot)).length > this.maxSnapshotBytes()) {
          snapshot = null;
          snapshotTooLarge = true;
        }
      }

      this.send(ws, {
        type: "welcome",
        clientId: attachment.clientId,
        role,
        mode: mode ?? "co-edit",
        participants: this.participants(),
        snapshot,
        presence: Object.fromEntries(this.presence),
        chat: parseStoredChat(chat),
        rev: this.rev,
        requireIdentity: requireIdentity ?? false,
        identitySupported: isIdentityConfigured(this.env.COLLAB_IDENTITY_SECRET),
        lockedLayerIds: lockedLayerIds ?? [],
        ...(welcomeInvites ? { invites: welcomeInvites } : {}),
        features: [CRDT_FEATURE],
      });
      if (snapshotTooLarge) {
        attachment.snapshotWithheld = true;
        ws.serializeAttachment(attachment);
        this.send(ws, tooLargeError());
      }

      this.broadcastParticipants(ws);
    } finally {
      this.joiningSockets.delete(ws);
    }
  }

  /**
   * A whole-project snapshot from a client on the snapshot protocol. It is
   * checked as before and then written into the session document as the
   * differences from it, so op-level clients receive it as an ordinary update.
   */
  private async handleSnapshot(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "snapshot" }>,
    byteLength: number,
  ): Promise<void> {
    const [rawMode, rawLockedLayerIds] = await Promise.all([
      this.ctx.storage.get<CollaborationMode>("mode"),
      this.ctx.storage.get<string[]>("lockedLayerIds"),
    ]);
    const relayDoc = await this.relayDocument();
    // A snapshot client that was not sent the project (it outgrew the frame
    // cap) would delete everything its own project lacks.
    if (attachment.snapshotWithheld) {
      this.send(ws, tooLargeError());
      return;
    }
    const mode = rawMode ?? "co-edit";
    const lockedLayerIds = rawLockedLayerIds ?? [];
    const storedSnapshot = relayDoc.project.isEmpty() ? null : relayDoc.materialize();

    const decision = authorizeSnapshot(
      attachment,
      mode,
      byteLength,
      this.maxSnapshotBytes(),
      storedSnapshot,
      message.project,
      lockedLayerIds,
    );
    if (!decision.ok) {
      this.send(ws, {
        type: "error",
        code: decision.code,
        message: decision.message,
      });
      if (shouldResyncRejectedSnapshot(decision) && storedSnapshot !== null) {
        this.send(ws, {
          type: "snapshot",
          project: storedSnapshot,
          origin: RELAY_SNAPSHOT_ORIGIN,
          rev: this.rev,
        });
      }
      return;
    }

    // `comments` is the one field the relay itself writes (see
    // `handleCommentMutation`), so keep the stored list when this snapshot
    // doesn't carry one — see `preserveStoredComments`.
    const project = preserveStoredComments(message.project ?? null, storedSnapshot);
    if (!project || typeof project !== "object" || Array.isArray(project)) return;
    if (relayDoc.byteSize + byteLength > this.maxDocBytes()) {
      this.send(ws, tooLargeError());
      return;
    }
    // Fans out through `fanOutDocUpdate`, which also advances `rev`.
    relayDoc.writeSnapshot(project as Record<string, unknown>, attachment.clientId);
  }

  /**
   * Answer an op-level client's state vector with the updates it lacks, then
   * `doc-synced` with the relay's own vector so it can send what we lack.
   */
  private async handleDocSync(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "doc-sync" }>,
  ): Promise<void> {
    const relayDoc = await this.relayDocument();
    relayDoc.forget(attachment.clientId);
    const frames = relayDoc.framesFor(message.stateVector, () => crypto.randomUUID());
    if (!frames) {
      this.send(ws, { type: "error", code: "bad-message", message: "Malformed state vector." });
      return;
    }
    for (const frame of frames) {
      this.send(ws, { type: "doc-update", ...frame, origin: RELAY_SNAPSHOT_ORIGIN, rev: this.rev });
    }
    this.send(ws, { type: "doc-synced", stateVector: relayDoc.stateVector(), rev: this.rev });
  }

  private async handleDocUpdate(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "doc-update" }>,
  ): Promise<void> {
    const [rawMode, rawLockedLayerIds] = await Promise.all([
      this.ctx.storage.get<CollaborationMode>("mode"),
      this.ctx.storage.get<string[]>("lockedLayerIds"),
    ]);
    const relayDoc = await this.relayDocument();
    const mode = rawMode ?? "co-edit";
    const result = relayDoc.receive(attachment.clientId, message, {
      canEdit: participantCanEdit(attachment, mode),
      isHost: attachment.role === "host",
      lockedLayerIds: rawLockedLayerIds ?? [],
    });
    if (result.status === "error") {
      const text =
        result.code === "forbidden" && attachment.editOverride === false
          ? "The host has set you to view-only."
          : result.message;
      this.send(ws, { type: "error", code: result.code, message: text });
    } else if (result.status === "reverted") {
      this.send(ws, {
        type: "error",
        code: "layer-locked",
        message: `Layer "${result.layerName}" is locked by the host and cannot be modified.`,
      });
    }
  }

  private handlePresence(
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "presence" }>,
  ): void {
    // Validate before storing/forwarding: cursor/view come straight off the
    // wire and land in peers' map APIs, so reject non-finite coordinates and
    // strip any hostile extra fields.
    const cursor = sanitizeCursor(message.cursor);
    const view = sanitizeView(message.view);
    this.presence.set(attachment.clientId, { cursor, view });
    this.broadcastExcept(attachment.clientId, {
      type: "presence",
      clientId: attachment.clientId,
      cursor,
      view,
    });
  }

  private async handleSetMode(
    ws: WebSocket,
    attachment: SocketAttachment,
    mode: CollaborationMode,
  ): Promise<void> {
    const forbidden = authorizeHostAction(attachment, "session mode");
    if (forbidden) {
      this.send(ws, {
        type: "error",
        code: "forbidden",
        message: forbidden,
      });
      return;
    }
    const next = normalizeMode(mode);
    await this.ctx.storage.put("mode", next);
    await this.appendLog({
      type: "set-mode",
      ts: Date.now(),
      mode: next,
    });
    // A session-wide mode change is authoritative: clear any per-participant
    // overrides so the new mode applies to everyone. Without this, a guest the
    // host previously pinned to can-edit would keep editing through a later
    // switch to view-only (a "sticky override" footgun), and there is otherwise
    // no path to reset an override back to "follow the session mode".
    const socketsWithAttachments = this.attachedSockets();
    const clearedAny = clearParticipantOverrides(
      socketsWithAttachments.map((entry) => entry.attachment),
    );
    if (clearedAny) {
      for (const { socket, attachment } of socketsWithAttachments) {
        socket.serializeAttachment(attachment);
      }
    }
    // Also clear persisted durable overrides so disconnected participants
    // don't reconnect with a stale override that contradicts the new mode.
    this.ensureTables();
    this.ctx.storage.sql.exec("DELETE FROM collab_durable_overrides");
    // Broadcast the cleared roster first, then the new mode, so clients have
    // dropped the stale `editOverride`s by the time they apply the mode change
    // (the two frames are sent back-to-back with no await between them).
    if (clearedAny) this.broadcastParticipants();
    this.broadcast({ type: "mode", mode: next });
  }

  private async handleSetParticipantMode(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "set-participant-mode" }>,
  ): Promise<void> {
    const forbidden = authorizeHostAction(attachment, "participant permissions");
    if (forbidden) {
      this.send(ws, {
        type: "error",
        code: "forbidden",
        message: forbidden,
      });
      return;
    }
    // `message` is untrusted JSON; setParticipantOverride does the type guard on
    // the lookup key and the strict-boolean coercion of `canEdit`, and returns
    // false for an unknown or already-disconnected target. That case needs no
    // error frame: the disconnect broadcast already reconciles the host's view.
    const socketsWithAttachments = this.attachedSockets();
    const changed = setParticipantOverride(
      attachment,
      socketsWithAttachments.map((entry) => entry.attachment),
      message.clientId,
      message.canEdit,
    );
    if (!changed) return;
    const target = socketsWithAttachments.find(
      (entry) => entry.attachment.clientId === message.clientId,
    );
    if (!target) return;
    const targetKey = getParticipantKey(target.attachment);
    this.writeDurableOverride(targetKey, target.attachment.editOverride);
    target.socket.serializeAttachment(target.attachment);
    await this.appendLog({
      type: "set-participant-mode",
      ts: Date.now(),
      clientId: message.clientId,
      // Record the normalized value that was actually applied, not the raw
      // client-supplied one.
      canEdit: target.attachment.editOverride === true,
    });
    // Everyone re-derives effective permission from the participants list (the
    // affected guest learns its own change here too), so a single broadcast
    // suffices.
    this.broadcastParticipants();
  }

  private async handleChat(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "chat" }>,
  ): Promise<void> {
    const prepared = prepareChatMessage({
      participant: attachment,
      message,
      now: Date.now(),
      generateId: () => crypto.randomUUID(),
    });
    if (!prepared) return;
    attachment.lastChatTs = prepared.nextLastChatTs;
    ws.serializeAttachment(attachment);
    const { chatMessage } = prepared;
    // Persist a bounded history so a late joiner (or a post-hibernation welcome)
    // sees the recent conversation. Read-modify-write is safe: a Durable Object
    // processes one message at a time and input-gates across the await.
    const log = parseStoredChat(await this.ctx.storage.get<string>("chat"));
    const { serialized } = appendBoundedChatHistory(log, chatMessage);
    try {
      await this.ctx.storage.put("chat", serialized);
    } catch {
      // Persisting failed (e.g. the single message still exceeds the value cap).
      // Don't let it propagate and close the socket; the message is still fanned
      // out below, it just won't join the late-joiner history.
    }
    // Broadcast to everyone including the sender so the server's ordering is the
    // single source of truth (the sender renders from this echo, not optimistically).
    this.broadcast({ type: "chat", message: chatMessage });
  }

  // -- helpers ----------------------------------------------------------------

  private async appendLog(entry: SessionLogEntry): Promise<void> {
    // Never let log persistence abort the caller: several handlers await this
    // inline and still have to close the socket, broadcast, or arm the
    // empty-session alarm afterwards.
    try {
      const log = parseStoredSessionLog(await this.ctx.storage.get<unknown>("sessionLog"));
      log.push(entry);
      // Bound by count AND serialized bytes, the same way the chat history is:
      // `join` entries carry an identity of unbounded size, so the count cap
      // alone cannot keep the value under the ~128 KiB per-value storage cap.
      let trimmed = log.slice(-SESSION_LOG_LIMIT);
      let byteLen = ENCODER.encode(JSON.stringify(trimmed)).length;
      while (trimmed.length > 1 && byteLen > MAX_SESSION_LOG_STORAGE_BYTES) {
        byteLen -= ENCODER.encode(JSON.stringify(trimmed[0])).length + 1;
        trimmed = trimmed.slice(1);
      }
      // Stored as the same JSON string the budget was measured against (the
      // chat history does the same), so the cap bounds what is persisted.
      await this.ctx.storage.put("sessionLog", JSON.stringify(trimmed));
    } catch {
      // Persisting failed (e.g. a single entry still exceeds the value cap).
      // The log is best-effort; the session state change it describes has
      // already been applied.
    }
  }

  /**
   * Live sockets paired with their deserialized attachment. Callers mutate the
   * returned attachment objects in place and must re-serialize that same
   * instance for the change to survive a hibernation wake.
   */
  private attachedSockets(): { socket: WebSocket; attachment: SocketAttachment }[] {
    const result: { socket: WebSocket; attachment: SocketAttachment }[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment) result.push({ socket, attachment });
    }
    return result;
  }

  private participants(except?: WebSocket): CollabParticipant[] {
    const result: CollabParticipant[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      const a = socket.deserializeAttachment() as SocketAttachment | null;
      if (a) {
        result.push(toWireParticipant(a));
      }
    }
    return result;
  }

  private broadcastParticipants(except?: WebSocket): void {
    this.broadcast({ type: "participants", participants: this.participants() }, except);
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Socket is gone; close handler will reconcile.
    }
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(payload);
      } catch {
        // Skip a dead socket; its close handler will reconcile.
      }
    }
  }

  private broadcastExcept(clientId: string, message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment() as SocketAttachment | null;
      if (a?.clientId === clientId) continue;
      try {
        socket.send(payload);
      } catch {
        // Skip a dead socket.
      }
    }
  }

  private async handleCommentMutation(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "comment-mutation" }>,
  ): Promise<void> {
    const action = message.action;
    if (!action || typeof action !== "object") {
      this.send(ws, {
        type: "error",
        code: "bad-message",
        message: "Missing or invalid comment-mutation action.",
      });
      return;
    }

    // Validate payloads for add/reply; toggle-resolve and delete only need a
    // string commentId and carry no untrusted object bodies. Do this before
    // rate-limiting so invalid frames always get bad-message and never consume
    // the per-socket interval.
    let sanitizedAction = action;
    if (action.type === "add") {
      const validated = validateComment(action.comment);
      if (!validated) {
        this.send(ws, {
          type: "error",
          code: "bad-message",
          message: "Invalid comment payload.",
        });
        return;
      }
      sanitizedAction = { type: "add", comment: validated };
    } else if (action.type === "reply") {
      if (!isBoundedId(action.commentId)) {
        this.send(ws, {
          type: "error",
          code: "bad-message",
          message: "Invalid reply target.",
        });
        return;
      }
      const validated = validateReply(action.reply);
      if (!validated) {
        this.send(ws, {
          type: "error",
          code: "bad-message",
          message: "Invalid reply payload.",
        });
        return;
      }
      sanitizedAction = { type: "reply", commentId: action.commentId, reply: validated };
    } else if (action.type === "toggle-resolve") {
      if (!isBoundedId(action.commentId)) {
        this.send(ws, {
          type: "error",
          code: "bad-message",
          message: "Invalid toggle-resolve target.",
        });
        return;
      }
      sanitizedAction = {
        type: "toggle-resolve",
        commentId: action.commentId,
        ...(action.resolved !== undefined ? { resolved: action.resolved === true } : {}),
      };
    } else if (action.type === "delete") {
      if (!isBoundedId(action.commentId)) {
        this.send(ws, {
          type: "error",
          code: "bad-message",
          message: "Invalid delete target.",
        });
        return;
      }
      sanitizedAction = { type: "delete", commentId: action.commentId };
    } else {
      this.send(ws, {
        type: "error",
        code: "bad-message",
        message: "Unsupported comment-mutation action type.",
      });
      return;
    }

    const mode = (await this.ctx.storage.get<CollaborationMode>("mode")) ?? "co-edit";
    if (!participantCanEdit(attachment, mode)) {
      this.send(ws, {
        type: "error",
        code: "forbidden",
        message: "You are in view-only mode and cannot comment.",
      });
      return;
    }

    // Rate-limit accepted, authorized mutations before storage work.
    const now = Date.now();
    if (
      attachment.lastCommentTs !== undefined &&
      now - attachment.lastCommentTs < MIN_COMMENT_INTERVAL_MS
    ) {
      return;
    }
    attachment.lastCommentTs = now;
    ws.serializeAttachment(attachment);

    const sanitizedMessage: Extract<ClientMessage, { type: "comment-mutation" }> = {
      type: "comment-mutation",
      action: sanitizedAction,
    };

    // Persist in the session document even when no project has been shared
    // yet, so early comments survive late joiners / reconnects. The relay
    // never inspects other project fields.
    const relayDoc = await this.relayDocument();
    const storedComments = relayDoc.project.fields.get("comments");

    try {
      // Non-object entries are dropped: project content is unvalidated, so a
      // client could plant `null` here and break every `.id` read below.
      const comments = (Array.isArray(storedComments) ? storedComments : []).filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
      );
      let updatedComments = comments;

      if (sanitizedAction.type === "add") {
        const newComment = sanitizedAction.comment as Record<string, unknown>;
        const exists = comments.some((c) => c && typeof c === "object" && c.id === newComment.id);
        if (!exists && comments.length >= MAX_COMMENTS_PER_SESSION) {
          this.send(ws, {
            type: "error",
            code: "bad-message",
            message: "Comment limit reached for this session.",
          });
          return;
        }
        updatedComments = exists ? comments : [...comments, newComment];
      } else if (sanitizedAction.type === "reply") {
        const replyObj = sanitizedAction.reply as Record<string, unknown>;
        const target = comments.find(
          (c) => c && typeof c === "object" && c.id === sanitizedAction.commentId,
        );
        if (!target) {
          this.send(ws, {
            type: "error",
            code: "bad-message",
            message: "Invalid reply target.",
          });
          return;
        }
        const targetReplies = Array.isArray(target.replies)
          ? (target.replies as Record<string, unknown>[])
          : [];
        if (targetReplies.length >= MAX_REPLIES_PER_COMMENT) {
          this.send(ws, {
            type: "error",
            code: "bad-message",
            message: "Reply limit reached for this comment.",
          });
          return;
        }
        updatedComments = comments.map((c) => {
          if (!c || typeof c !== "object" || c.id !== sanitizedAction.commentId) return c;
          const existingReplies = Array.isArray(c.replies)
            ? (c.replies as Record<string, unknown>[])
            : [];
          if (existingReplies.some((r) => r && typeof r === "object" && r.id === replyObj.id))
            return c;
          return { ...c, replies: [...existingReplies, replyObj] };
        });
      } else if (sanitizedAction.type === "toggle-resolve") {
        updatedComments = comments.map((c) =>
          c && typeof c === "object" && c.id === sanitizedAction.commentId
            ? {
                ...c,
                resolved:
                  sanitizedAction.resolved !== undefined ? sanitizedAction.resolved : !c.resolved,
              }
            : c,
        );
      } else if (sanitizedAction.type === "delete") {
        updatedComments = comments.filter(
          (c) => c && typeof c === "object" && c.id !== sanitizedAction.commentId,
        );
      }

      // Bound the document the way every other write is bounded. Check before
      // the write so an oversized value surfaces as an error the sender can
      // see rather than a throw the catch below would have to guess at.
      const grows = sanitizedAction.type === "add" || sanitizedAction.type === "reply";
      const added = grows ? ENCODER.encode(JSON.stringify(updatedComments)).length : 0;
      if (grows && relayDoc.byteSize + added > this.maxDocBytes()) {
        this.send(ws, {
          type: "error",
          code: "bad-message",
          message: "Project is too large to store this comment.",
        });
        return;
      }
      relayDoc.setField("comments", updatedComments);
    } catch {
      // The mutation never reached storage, so a late joiner or a reconnect
      // (both of which read from storage) would not see it. Tell the sender and
      // skip the fan-out rather than leaving connected peers holding a comment
      // that isn't persisted anywhere.
      this.send(ws, {
        type: "error",
        code: "bad-message",
        message: "Could not save the comment. Try again.",
      });
      return;
    }

    this.broadcast(sanitizedMessage, ws);
  }

  private handleMintInvite(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "mint-invite" }>,
  ): void {
    const forbidden = authorizeHostAction(attachment, "session invites");
    if (forbidden) {
      this.send(ws, { type: "error", code: "forbidden", message: forbidden });
      return;
    }
    const role: CollaborationMode = message.role === "view-only" ? "view-only" : "co-edit";
    const token = crypto.randomUUID();
    const maxUses =
      Number.isSafeInteger(message.maxUses) && (message.maxUses as number) > 0
        ? (message.maxUses as number)
        : undefined;
    const invite: CollabInvite = {
      token,
      role,
      createdAt: Date.now(),
      ...(maxUses !== undefined ? { maxUses } : {}),
      useCount: 0,
      revoked: false,
    };
    this.writeInvite(invite);
    this.broadcastHostOnly({ type: "invite-created", invite });
  }

  private handleRevokeInvite(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "revoke-invite" }>,
  ): void {
    const forbidden = authorizeHostAction(attachment, "session invites");
    if (forbidden) {
      this.send(ws, { type: "error", code: "forbidden", message: forbidden });
      return;
    }
    if (typeof message.token === "string") {
      this.revokeInviteToken(message.token);
      this.broadcastHostOnly({ type: "invite-revoked", token: message.token });
    }
  }

  private async handleSetSessionConfig(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "set-session-config" }>,
  ): Promise<void> {
    const forbidden = authorizeHostAction(attachment, "session settings");
    if (forbidden) {
      this.send(ws, { type: "error", code: "forbidden", message: forbidden });
      return;
    }
    if (message.requireIdentity !== undefined) {
      const req = message.requireIdentity === true;
      // Refuse to arm a gate no one could pass: without an issuer, every
      // joiner is anonymous, so turning this on would strand the host's own
      // session with no way to undo it from a second client.
      if (req && !isIdentityConfigured(this.env.COLLAB_IDENTITY_SECRET)) {
        this.send(ws, {
          type: "error",
          code: "identity-unavailable",
          message: "This relay has no sign-in provider configured.",
        });
        return;
      }
      await this.ctx.storage.put("requireIdentity", req);
      this.broadcast({ type: "session-config", requireIdentity: req });
    }
  }

  private async handleSetLayerLocks(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "set-layer-locks" }>,
  ): Promise<void> {
    const forbidden = authorizeHostAction(attachment, "layer locks");
    if (forbidden) {
      this.send(ws, { type: "error", code: "forbidden", message: forbidden });
      return;
    }
    const lockedLayerIds = Array.isArray(message.lockedLayerIds)
      ? message.lockedLayerIds.filter((id: unknown): id is string => typeof id === "string")
      : [];
    await this.ctx.storage.put("lockedLayerIds", lockedLayerIds);
    this.broadcast({ type: "layer-locks", lockedLayerIds });
  }

  private handleKickParticipant(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "kick-participant" }>,
  ): void {
    const forbidden = authorizeHostAction(attachment, "participant moderation");
    if (forbidden) {
      this.send(ws, { type: "error", code: "forbidden", message: forbidden });
      return;
    }
    if (typeof message.clientId !== "string") return;
    const target = this.attachedSockets().find(
      (entry) => entry.attachment.clientId === message.clientId,
    );
    if (!target || target.attachment.role === "host") return;

    this.send(target.socket, {
      type: "kicked",
      reason: message.reason ?? "Kicked by session host.",
    });
    try {
      target.socket.close(4000, "Kicked by host");
    } catch {
      // Already closing
    }
  }

  private handleBlockParticipant(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "block-participant" }>,
  ): void {
    const forbidden = authorizeHostAction(attachment, "participant moderation");
    if (forbidden) {
      this.send(ws, { type: "error", code: "forbidden", message: forbidden });
      return;
    }
    if (typeof message.clientId !== "string") return;
    const target = this.attachedSockets().find(
      (entry) => entry.attachment.clientId === message.clientId,
    );
    if (!target || target.attachment.role === "host") return;

    const targetKey = getParticipantKey(target.attachment);
    this.blockKey(targetKey);

    this.send(target.socket, {
      type: "kicked",
      reason: message.reason ?? "Blocked by session host.",
    });
    try {
      target.socket.close(4001, "Blocked by host");
    } catch {
      // Already closing
    }
  }

  private broadcastHostOnly(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment() as SocketAttachment | null;
      if (a?.role === "host") {
        try {
          socket.send(payload);
        } catch {
          // ignore
        }
      }
    }
  }
}
