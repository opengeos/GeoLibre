import { DurableObject } from "cloudflare:workers";
import type {
  CollabChatMessage,
  CollabParticipant,
  ClientMessage,
  CollaborationMode,
  CollaborationRole,
  PresenceEntry,
  ServerMessage,
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
  authorizeHostAction,
  authorizeSnapshot,
  CHAT_HISTORY_LIMIT,
  clearParticipantOverrides,
  EMPTY_SESSION_TTL_MS,
  MAX_CHAT_STORAGE_BYTES,
  MAX_CHAT_TEXT_LENGTH,
  MAX_SNAPSHOT_BYTES,
  parseStoredChat,
  MIN_CHAT_INTERVAL_MS,
  normalizeMode,
  participantCanEdit,
  sanitizeColor,
  sanitizeCursor,
  sanitizeDisplayName,
  sanitizeView,
  setParticipantOverride,
  toWireParticipant,
  type SessionParticipant,
} from "@geolibre/collab-core";

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

export interface Env {
  COLLAB_SESSION: DurableObjectNamespace<CollabSession>;
}

// The snapshot cap, empty-session TTL, and chat limits now live in
// `@geolibre/collab-core` (imported above) so both relays enforce one set of
// numbers; see that module for why each value is what it is.

// Stateless and reused across frames (snapshots can arrive several times a
// second), so we don't allocate a new encoder per message.
const ENCODER = new TextEncoder();

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
      };
      const mode: CollaborationMode = body.mode === "view-only" ? "view-only" : "co-edit";
      await this.ctx.storage.put({
        mode,
        hostToken: body.hostToken ?? "",
        rev: 0,
      });
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
        this.handleSetParticipantMode(ws, attachment, message);
        break;
      case "chat":
        await this.handleChat(ws, attachment, message);
        break;
      case "comment-mutation":
        await this.handleCommentMutation(ws, attachment, message);
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment) this.presence.delete(attachment.clientId);
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
    }
  }

  // -- handlers ---------------------------------------------------------------

  private async handleJoin(
    ws: WebSocket,
    message: Extract<ClientMessage, { type: "join" }>,
  ): Promise<void> {
    // Ignore a duplicate join on an already-joined socket: re-running it would
    // mint a new clientId and orphan the socket's previous presence entry (the
    // close handler only deletes the current clientId).
    if (ws.deserializeAttachment()) return;

    const [storedToken, mode, rev, snapshot, chat] = await Promise.all([
      this.ctx.storage.get<string>("hostToken"),
      this.ctx.storage.get<CollaborationMode>("mode"),
      this.ctx.storage.get<number>("rev"),
      this.ctx.storage.get<string>("snapshot"),
      this.ctx.storage.get<string>("chat"),
    ]);

    const role: CollaborationRole =
      message.hostToken && storedToken && message.hostToken === storedToken ? "host" : "guest";

    const attachment: SocketAttachment = {
      // Assign the id server-side instead of trusting the client's, so a
      // participant can't claim another's clientId to hijack their presence or
      // collide React keys. The welcome echoes it back for the client to adopt.
      clientId: crypto.randomUUID(),
      // Guard against a non-string displayName (JSON.parse won't enforce the
      // type) so a crafted frame can't crash the handler on `.slice`.
      displayName: sanitizeDisplayName(message.displayName),
      // Only accept a hex color; fall back to neutral grey so a hostile value
      // never reaches peers (defense-in-depth with the client's DOM rendering).
      // Guard the type first: `.test()` coerces a non-string (number/array) to a
      // string, which could spuriously pass and store a non-string color.
      color: sanitizeColor(message.color),
      role,
    };
    ws.serializeAttachment(attachment);

    this.send(ws, {
      type: "welcome",
      clientId: attachment.clientId,
      role,
      mode: mode ?? "co-edit",
      participants: this.participants(),
      // A corrupt stored snapshot (partial write/storage error) must not throw
      // here — that would close the socket 1011 and every reconnect would hit
      // the same poison value, locking the whole session out. Fall back to null.
      snapshot: parseStoredSnapshot(snapshot),
      // Bootstrap the joiner with existing participants' live cursors/viewports.
      presence: Object.fromEntries(this.presence),
      // Bootstrap the joiner with the recent chat history.
      chat: parseStoredChat(chat),
      rev: rev ?? 0,
    });

    // The joiner already has the up-to-date list from `welcome` above; only the
    // other participants need the update.
    this.broadcastParticipants(ws);
  }

  private async handleSnapshot(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "snapshot" }>,
    byteLength: number,
  ): Promise<void> {
    const mode = (await this.ctx.storage.get<CollaborationMode>("mode")) ?? "co-edit";
    // A host-set per-participant override takes precedence over the session
    // default, so a single guest can be pinned to view-only (or granted edit) in
    // an otherwise co-edit (or view-only) session (#754, Part 3).
    const decision = authorizeSnapshot(attachment, mode, byteLength);
    if (!decision.ok) {
      this.send(ws, {
        type: "error",
        code: decision.code,
        message: decision.message,
      });
      return;
    }

    // The project was parsed in webSocketMessage; re-serialize it only to
    // persist a string for storage and forward the object verbatim. `comments`
    // is the one field the relay touches (it also writes it directly in
    // `handleCommentMutation`), so preserve the stored list when this snapshot
    // doesn't carry one — see `preserveStoredComments`. Peers get the merged
    // project below, which heals a sender that had drifted.
    const project = preserveStoredComments(
      message.project ?? null,
      parseStoredSnapshot(await this.ctx.storage.get<string>("snapshot")),
    );
    // `rev` is written during /init before any socket can join, so the stored
    // value is always present; the `?? 0` is a defensive floor, never the
    // client's counter (a server-owned monotonic value must not trust input).
    const rev = ((await this.ctx.storage.get<number>("rev")) ?? 0) + 1;
    await this.ctx.storage.put({
      snapshot: JSON.stringify(project),
      rev,
    });

    this.broadcast(
      {
        type: "snapshot",
        project,
        origin: attachment.clientId,
        rev,
      },
      ws,
    );
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
    // Broadcast the cleared roster first, then the new mode, so clients have
    // dropped the stale `editOverride`s by the time they apply the mode change
    // (the two frames are sent back-to-back with no await between them).
    if (clearedAny) this.broadcastParticipants();
    this.broadcast({ type: "mode", mode: next });
  }

  private handleSetParticipantMode(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "set-participant-mode" }>,
  ): void {
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
    // `changed` implies the entry is in this same snapshot -- setParticipantOverride
    // found and mutated it, with no await in between -- so this always resolves.
    const target = socketsWithAttachments.find(
      (entry) => entry.attachment.clientId === message.clientId,
    );
    if (!target) return;
    target.socket.serializeAttachment(target.attachment);
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
    // Chat is open to everyone in the session, including view-only guests; only
    // project edits are gated. Reject an empty or non-string body.
    const text =
      typeof message.text === "string" ? message.text.trim().slice(0, MAX_CHAT_TEXT_LENGTH) : "";
    if (!text) return;
    // Per-socket rate limit: silently drop a burst that arrives faster than the
    // floor so one client can't flood the storage-op budget / fan-out. The last
    // accepted timestamp rides on the attachment, so it survives a hibernation.
    const now = Date.now();
    if (attachment.lastChatTs !== undefined && now - attachment.lastChatTs < MIN_CHAT_INTERVAL_MS) {
      return;
    }
    attachment.lastChatTs = now;
    ws.serializeAttachment(attachment);
    const chatMessage: CollabChatMessage = {
      id: crypto.randomUUID(),
      clientId: attachment.clientId,
      displayName: attachment.displayName,
      color: attachment.color,
      text,
      // Reuse the cursor sanitizer so a crafted coordinate can't reach peers'
      // map APIs as NaN/strings.
      coordinate: sanitizeCursor(message.coordinate),
      ts: now,
    };
    // Persist a bounded history so a late joiner (or a post-hibernation welcome)
    // sees the recent conversation. Read-modify-write is safe: a Durable Object
    // processes one message at a time and input-gates across the await.
    const log = parseStoredChat(await this.ctx.storage.get<string>("chat"));
    log.push(chatMessage);
    // Bound by count AND serialized bytes: 50 messages can still exceed the
    // ~128 KiB per-value storage cap when they hold long multi-byte (e.g. CJK)
    // text, so drop the oldest until the JSON fits a safe budget. Track the byte
    // length incrementally (encode once, then subtract each evicted entry plus
    // its comma separator) so the loop stays O(n) rather than re-encoding the
    // whole array each iteration.
    let trimmed = log.slice(-CHAT_HISTORY_LIMIT);
    let byteLen = ENCODER.encode(JSON.stringify(trimmed)).length;
    while (trimmed.length > 1 && byteLen > MAX_CHAT_STORAGE_BYTES) {
      byteLen -= ENCODER.encode(JSON.stringify(trimmed[0])).length + 1;
      trimmed = trimmed.slice(1);
    }
    const serialized = JSON.stringify(trimmed);
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

    // Persist even when no full project snapshot has been written yet, so early
    // comments survive late joiners / reconnects. Seed an empty object when
    // storage is empty or corrupt — the relay never inspects other project fields.
    const rawSnapshot = await this.ctx.storage.get<string>("snapshot");
    let parsed: Record<string, unknown> = { comments: [] };
    if (rawSnapshot) {
      try {
        const value = JSON.parse(rawSnapshot) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsed = value as Record<string, unknown>;
        }
      } catch {
        // Fall through with the empty seed; still fan out below.
      }
    }

    try {
      const comments = Array.isArray(parsed.comments)
        ? (parsed.comments as Record<string, unknown>[])
        : [];
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

      parsed.comments = updatedComments;
      const serialized = JSON.stringify(parsed);
      // `handleSnapshot` bounds a full project the same way. Check before the
      // put so an oversized value surfaces as an error the sender can see
      // rather than a throw the catch below would have to guess at.
      if (ENCODER.encode(serialized).length > MAX_SNAPSHOT_BYTES) {
        this.send(ws, {
          type: "error",
          code: "bad-message",
          message: "Project is too large to store this comment.",
        });
        return;
      }
      await this.ctx.storage.put("snapshot", serialized);
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
}
