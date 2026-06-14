import { DurableObject } from "cloudflare:workers";
import type {
  CollabParticipant,
  ClientMessage,
  CollaborationMode,
  CollaborationRole,
  ServerMessage,
} from "./protocol";

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

// Stateless and reused across frames (snapshots can arrive several times a
// second), so we don't allocate a new encoder per message.
const ENCODER = new TextEncoder();

interface SocketAttachment {
  clientId: string;
  displayName: string;
  color: string;
  role: CollaborationRole;
}

interface PresenceState {
  cursor?: { lng: number; lat: number } | null;
  view?: unknown;
}

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
      if (existing) {
        return Response.json({ ok: true, alreadyInitialized: true });
      }
      const body = (await request.json()) as {
        mode?: CollaborationMode;
        hostToken?: string;
      };
      const mode: CollaborationMode =
        body.mode === "view-only" ? "view-only" : "co-edit";
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

  async webSocketMessage(
    ws: WebSocket,
    raw: string | ArrayBuffer,
  ): Promise<void> {
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
        await this.handleSnapshot(
          ws,
          attachment,
          message,
          ENCODER.encode(raw).length,
        );
        break;
      case "presence":
        this.handlePresence(attachment, message);
        break;
      case "set-mode":
        await this.handleSetMode(ws, attachment, message.mode);
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
    this.broadcast(
      { type: "participants", participants: this.participants(ws) },
      ws,
    );
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
    const [storedToken, mode, rev, snapshot] = await Promise.all([
      this.ctx.storage.get<string>("hostToken"),
      this.ctx.storage.get<CollaborationMode>("mode"),
      this.ctx.storage.get<number>("rev"),
      this.ctx.storage.get<string>("snapshot"),
    ]);

    const role: CollaborationRole =
      message.hostToken && storedToken && message.hostToken === storedToken
        ? "host"
        : "guest";

    const attachment: SocketAttachment = {
      // Assign the id server-side instead of trusting the client's, so a
      // participant can't claim another's clientId to hijack their presence or
      // collide React keys. The welcome echoes it back for the client to adopt.
      clientId: crypto.randomUUID(),
      // Guard against a non-string displayName (JSON.parse won't enforce the
      // type) so a crafted frame can't crash the handler on `.slice`.
      displayName:
        (typeof message.displayName === "string" ? message.displayName : "")
          .slice(0, 60) || "Guest",
      // Only accept a hex color; fall back to neutral grey so a hostile value
      // never reaches peers (defense-in-depth with the client's DOM rendering).
      color: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(message.color)
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
      snapshot: snapshot ? (JSON.parse(snapshot) as unknown) : null,
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
    const mode =
      (await this.ctx.storage.get<CollaborationMode>("mode")) ?? "co-edit";
    if (attachment.role !== "host" && mode === "view-only") {
      this.send(ws, {
        type: "error",
        code: "forbidden",
        message: "This session is view-only.",
      });
      return;
    }
    if (byteLength > MAX_SNAPSHOT_BYTES) {
      this.send(ws, {
        type: "error",
        code: "too-large",
        message:
          "Project is too large to sync live. Share it via URL instead.",
      });
      return;
    }

    // The project was already parsed in webSocketMessage; store and forward it
    // directly. The relay never inspects the project's internals.
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
    this.presence.set(attachment.clientId, {
      cursor: message.cursor,
      view: message.view,
    });
    this.broadcastExcept(attachment.clientId, {
      type: "presence",
      clientId: attachment.clientId,
      cursor: message.cursor,
      view: message.view,
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
    this.broadcast({ type: "mode", mode: next });
  }

  // -- helpers ----------------------------------------------------------------

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
        });
      }
    }
    return result;
  }

  private broadcastParticipants(except?: WebSocket): void {
    this.broadcast(
      { type: "participants", participants: this.participants() },
      except,
    );
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
