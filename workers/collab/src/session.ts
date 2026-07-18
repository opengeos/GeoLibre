import { DurableObject } from "cloudflare:workers";
import type {
  CollabChatMessage,
  CollabCursor,
  CollabParticipant,
  CollabView,
  ClientMessage,
  CollaborationMode,
  CollaborationRole,
  PresenceEntry,
  ServerMessage,
} from "./protocol";

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

// Accepted participant color: a 3- or 6-digit hex. Shared by the join path and
// the stored-chat validator so both enforce the same shape.
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Accept a cursor only when both coordinates are finite numbers, so a crafted
 *  frame can't push NaN/strings into peers' `marker.setLngLat`. */
function sanitizeCursor(c: unknown): CollabCursor | null {
  if (c && typeof c === "object") {
    const { lng, lat } = c as Record<string, unknown>;
    if (finite(lng) && finite(lat)) return { lng, lat };
  }
  return null;
}

/** Accept a view only with a finite center; coerce the rest and keep bbox only
 *  when it is a finite 4-tuple. Drops any hostile extra fields. */
function sanitizeView(v: unknown): CollabView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const center = o.center;
  if (!Array.isArray(center) || !finite(center[0]) || !finite(center[1])) {
    return null;
  }
  const view: CollabView = {
    center: [center[0], center[1]],
    zoom: finite(o.zoom) ? o.zoom : 0,
    bearing: finite(o.bearing) ? o.bearing : 0,
    pitch: finite(o.pitch) ? o.pitch : 0,
  };
  const bbox = o.bbox;
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every((n) => finite(n))) {
    view.bbox = [bbox[0], bbox[1], bbox[2], bbox[3]];
  }
  return view;
}

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

// Cloudflare caps a single WebSocket message at ~1 MiB. Reject project
// snapshots above this so one oversized embedded FeatureCollection can't blow
// the actor; the client surfaces a "share via URL instead" hint.
const MAX_SNAPSHOT_BYTES = 1_000_000;

// Reclaim an empty session's storage this long after the last socket closes, so
// abandoned codes don't accumulate. A rejoin before the alarm fires cancels it.
const EMPTY_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

// Cap a single chat message so one frame can't store an unbounded string.
const MAX_CHAT_TEXT_LENGTH = 2000;
// How many recent chat messages to retain so a late joiner sees recent history.
// Persisted (not in-memory) so it survives a hibernation between messages.
const CHAT_HISTORY_LIMIT = 50;
// Hard byte budget for the persisted chat log, comfortably under Cloudflare's
// ~128 KiB per-value storage cap (multi-byte text can blow the count limit).
const MAX_CHAT_STORAGE_BYTES = 100_000;
// Minimum gap between a socket's chat frames. Each chat costs a storage
// read+write and a fan-out, so silently drop bursts faster than this floor to
// keep one client from exhausting the session's storage-op budget. Generous
// enough that normal typing/sending is never affected.
const MIN_CHAT_INTERVAL_MS = 250;

// Stateless and reused across frames (snapshots can arrive several times a
// second), so we don't allocate a new encoder per message.
const ENCODER = new TextEncoder();

interface SocketAttachment {
  clientId: string;
  displayName: string;
  color: string;
  role: CollaborationRole;
  /**
   * Host-set per-participant edit override (#754, Part 3). `undefined` means
   * "follow the session mode"; `true`/`false` pins this socket to can-edit /
   * view-only. Stored on the attachment so it survives a hibernation wake and is
   * never persisted to storage (it is keyed to a clientId, which is per-socket).
   */
  editOverride?: boolean;
  /** Epoch-ms of this socket's last accepted chat frame, for rate-limiting. */
  lastChatTs?: number;
}

/** Effective edit permission: the host always edits; otherwise a host-set
 *  override wins, falling back to the session mode. */
function canEdit(attachment: SocketAttachment, mode: CollaborationMode): boolean {
  if (attachment.role === "host") return true;
  if (attachment.editOverride !== undefined) return attachment.editOverride;
  return mode === "co-edit";
}

/** Validate a single stored chat entry's field types so a corrupt record can't
 *  reach clients (where it would, e.g., crash `coordinate.lat.toFixed`). */
function isValidChatMessage(m: unknown): m is CollabChatMessage {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  const coord = o.coordinate as Record<string, unknown> | null | undefined;
  const coordOk =
    coord === null ||
    coord === undefined ||
    (typeof coord === "object" && finite(coord.lng) && finite(coord.lat));
  return (
    typeof o.id === "string" &&
    typeof o.clientId === "string" &&
    typeof o.displayName === "string" &&
    // Reject records whose field types/shapes would crash or mislead a client:
    // a non-hex color, a blank body, a non-finite timestamp, or a bad coordinate
    // (which would crash `coordinate.lat.toFixed`). Not a full write-path mirror.
    typeof o.color === "string" &&
    HEX_COLOR_RE.test(o.color) &&
    typeof o.text === "string" &&
    o.text !== "" &&
    finite(o.ts) &&
    coordOk
  );
}

/** Parse the stored chat log defensively; a corrupt value yields an empty log
 *  (rather than throwing, which would lock joiners out of the welcome) and any
 *  malformed individual entries are dropped. */
function parseStoredChat(raw: string | undefined): CollabChatMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isValidChatMessage) : [];
  } catch {
    return [];
  }
}

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
      displayName:
        (typeof message.displayName === "string" ? message.displayName : "").slice(0, 60) ||
        "Guest",
      // Only accept a hex color; fall back to neutral grey so a hostile value
      // never reaches peers (defense-in-depth with the client's DOM rendering).
      // Guard the type first: `.test()` coerces a non-string (number/array) to a
      // string, which could spuriously pass and store a non-string color.
      color:
        typeof message.color === "string" && HEX_COLOR_RE.test(message.color)
          ? message.color
          : "#888888",
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
    if (!canEdit(attachment, mode)) {
      this.send(ws, {
        type: "error",
        code: "forbidden",
        message:
          attachment.editOverride === false
            ? "The host has set you to view-only."
            : "This session is view-only.",
      });
      return;
    }
    if (byteLength > MAX_SNAPSHOT_BYTES) {
      this.send(ws, {
        type: "error",
        code: "too-large",
        message: "Project is too large to sync live. Share it via URL instead.",
      });
      return;
    }

    // The project was parsed in webSocketMessage; re-serialize it only to
    // persist a string for storage and forward the object verbatim. The relay
    // never reads any field inside the project.
    const project = message.project ?? null;
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
    if (attachment.role !== "host") {
      this.send(ws, {
        type: "error",
        code: "forbidden",
        message: "Only the host can change the session mode.",
      });
      return;
    }
    const next: CollaborationMode = mode === "view-only" ? "view-only" : "co-edit";
    await this.ctx.storage.put("mode", next);
    // A session-wide mode change is authoritative: clear any per-participant
    // overrides so the new mode applies to everyone. Without this, a guest the
    // host previously pinned to can-edit would keep editing through a later
    // switch to view-only (a "sticky override" footgun), and there is otherwise
    // no path to reset an override back to "follow the session mode".
    let clearedAny = false;
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment() as SocketAttachment | null;
      if (a && a.editOverride !== undefined) {
        a.editOverride = undefined;
        socket.serializeAttachment(a);
        clearedAny = true;
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
    if (attachment.role !== "host") {
      this.send(ws, {
        type: "error",
        code: "forbidden",
        message: "Only the host can change participant permissions.",
      });
      return;
    }
    // `message` is untrusted JSON, so guard the lookup key's type (mirrors the
    // strict-boolean coercion below) before matching it against attachments.
    if (typeof message.clientId !== "string") return;
    // Find the addressed participant's socket and pin its override. The host
    // (and any other host socket) is always an editor, so refuse to override one
    // — that keeps `editOverride` meaningful only for guests.
    const target = this.socketByClientId(message.clientId);
    // Target disconnected between the host's click and this frame: the
    // disconnect already broadcasts an updated roster, so the host's view (and
    // the now-absent toggle) reconciles on its own; no error frame needed.
    if (!target) return;
    const targetAttachment = target.deserializeAttachment() as SocketAttachment | null;
    if (!targetAttachment || targetAttachment.role === "host") return;
    // Coerce to a strict boolean: `message` is untrusted JSON (the static type
    // is erased at runtime), so a crafted `"canEdit": 1` must not store a
    // non-boolean on the attachment.
    targetAttachment.editOverride = message.canEdit === true;
    target.serializeAttachment(targetAttachment);
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

  private socketByClientId(clientId: string): WebSocket | null {
    for (const socket of this.ctx.getWebSockets()) {
      const a = socket.deserializeAttachment() as SocketAttachment | null;
      if (a?.clientId === clientId) return socket;
    }
    return null;
  }

  private participants(except?: WebSocket): CollabParticipant[] {
    const result: CollabParticipant[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      const a = socket.deserializeAttachment() as SocketAttachment | null;
      if (a) {
        result.push({
          clientId: a.clientId,
          displayName: a.displayName,
          color: a.color,
          role: a.role,
          // Normalize the attachment's `undefined` (follow session mode) to the
          // wire's `null`; the host is always an editor with no override.
          editOverride: a.role === "host" ? null : (a.editOverride ?? null),
        });
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
}
