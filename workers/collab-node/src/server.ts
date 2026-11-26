import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  MAX_COMMENTS_PER_SESSION,
  MAX_REPLIES_PER_COMMENT,
  MAX_SNAPSHOT_BYTES,
  MIN_COMMENT_INTERVAL_MS,
  appendBoundedChatHistory,
  authorizeHostAction,
  authorizeSnapshot,
  RELAY_SNAPSHOT_ORIGIN,
  resolveJoin,
  shouldLogDocUpdate,
  shouldResyncRejectedSnapshot,
  clearParticipantOverrides,
  diffLockedLayers,
  getParticipantKey,
  isAllowedOrigin,
  isIdentityConfigured,
  normalizeMode,
  participantCanEdit,
  prepareChatMessage,
  preserveStoredComments,
  sanitizeCursor,
  sanitizeView,
  setParticipantOverride,
  timingSafeEqual,
  toWireParticipant,
  validateComment,
  validateReply,
  isBoundedId,
  type ClientMessage,
  type CollabInvite,
  type CollaborationMode,
  type PresenceEntry,
  type ServerMessage,
  type SessionLogEntry,
  type SessionParticipant,
  CRDT_FEATURE,
} from "@geolibre/collab-core";
import { docUpdateMessages, MAX_DOC_BYTES, RelayDoc } from "@geolibre/collab-core/crdt-relay";
import { WebSocket, WebSocketServer } from "ws";
import { SessionStore, type StoredSession } from "./store.js";

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
/** Cap on the `POST /sessions` request body; the payload is a tiny JSON object. */
const MAX_SESSION_BODY_BYTES = 16_384;

const DEFAULT_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const ENCODER = new TextEncoder();

const MAX_RATE_LIMIT_KEYS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;

const MAX_PENDING_FRAMES = 64;

interface Peer {
  socket: WebSocket;
  participant?: SessionParticipant;
  /**
   * Tail of this peer's frame-handling chain. `handleMessage` became async when
   * identity verification did (Web Crypto has no sync HMAC), and `ws` delivers
   * frames without waiting, so frames are chained rather than started
   * concurrently — otherwise a `snapshot` sent right behind a `join` could
   * overtake it and be rejected with "Send a join message first".
   */
  queue?: Promise<void>;
  /** Number of frames currently queued or running for this peer. */
  pendingFrames: number;
  /** Set when a `join` frame is currently awaiting async verification on this socket. */
  joining?: boolean;
  /** Set when the relay closes this peer due to frame-queue overflow. */
  overflowClosed?: boolean;
}

interface LiveSession {
  peers: Set<Peer>;
  presence: Map<string, PresenceEntry>;
  cleanup?: NodeJS.Timeout;
  /** The session's op-level document, opened on first use (`relayDocument`). */
  doc?: RelayDoc;
  /** Revision counter, mirrored from storage while the document is open. */
  rev: number;
  /** When each origin's last document change was logged. */
  lastLogged: Map<string, number>;
  /** Set while the relay writes the comment list (see fanOutDocUpdate). */
  commentWrite?: boolean;
}

export interface RelayOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  maxSnapshotBytes?: number;
  /** Ceiling on a session's op-level document; `COLLAB_MAX_DOC_BYTES`. */
  maxDocBytes?: number;
  idleTtlMs?: number;
  trustProxy?: boolean;
  /**
   * Number of trusted reverse-proxy hops in front of the relay when
   * `trustProxy` is enabled (defaults to `1`, or `TRUST_PROXY_HOPS`).
   * The client IP is read that many entries from the right of `X-Forwarded-For`.
   */
  trustProxyHops?: number;
  /**
   * HMAC-SHA256 secret shared with this deployment's identity issuer, normally
   * from `COLLAB_IDENTITY_SECRET`. Unset disables identity: `identityToken` is
   * ignored, every joiner is anonymous, and "require a signed-in account"
   * cannot be turned on.
   */
  identitySecret?: string;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function randomToken(): string {
  return randomBytes(24).toString("hex");
}

function sendRaw(peer: Peer, payload: string): void {
  if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(payload);
}

function send(peer: Peer, message: ServerMessage): void {
  sendRaw(peer, JSON.stringify(message));
}

/** CORS headers for every HTTP response; matches the Worker's `CORS_HEADERS`. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-max-age": "86400",
} as const;

function json(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...CORS_HEADERS,
    ...headers,
  });
  response.end(JSON.stringify(body));
}

/**
 * Read the bearer token from an `Authorization` header.
 *
 * @param header - The raw header value, if any.
 * @returns The trimmed token, or `""` when the header is missing or not a
 *   bearer credential.
 */
function bearerToken(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

export function createRelay(options: RelayOptions = {}): {
  server: Server;
  store: SessionStore;
  close: () => Promise<void>;
} {
  const dbPath = options.dbPath ?? process.env.COLLAB_DB_PATH ?? "./data/collab.sqlite";
  const maxSnapshotBytes =
    options.maxSnapshotBytes ?? positive(process.env.COLLAB_MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_BYTES);
  const maxDocBytes =
    options.maxDocBytes ?? positive(process.env.COLLAB_MAX_DOC_BYTES, MAX_DOC_BYTES);
  const idleTtlMs =
    options.idleTtlMs ?? positive(process.env.COLLAB_IDLE_TTL_MS, DEFAULT_IDLE_TTL_MS);
  const trustProxy =
    options.trustProxy ?? (process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1");
  const trustProxyHops = Math.max(
    1,
    Math.floor(options.trustProxyHops ?? positive(process.env.TRUST_PROXY_HOPS, 1)),
  );
  const identitySecret = options.identitySecret ?? process.env.COLLAB_IDENTITY_SECRET;
  const identitySupported = isIdentityConfigured(identitySecret);
  const store = new SessionStore(dbPath);
  const sessions = new Map<string, LiveSession>();
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  let lastRateLimitSweep = 0;

  function checkRateLimit(key: string, maxRequests = 10, windowMs = 60_000): boolean {
    const now = Date.now();
    if (now - lastRateLimitSweep > SWEEP_INTERVAL_MS || rateLimitMap.size >= MAX_RATE_LIMIT_KEYS) {
      for (const [k, rec] of rateLimitMap.entries()) {
        if (now > rec.resetAt) rateLimitMap.delete(k);
      }
      while (rateLimitMap.size >= MAX_RATE_LIMIT_KEYS) {
        const oldestKey = rateLimitMap.keys().next().value;
        if (oldestKey === undefined) break;
        rateLimitMap.delete(oldestKey);
      }
      lastRateLimitSweep = now;
    }
    const record = rateLimitMap.get(key);
    if (!record || now > record.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (record.count >= maxRequests) {
      return false;
    }
    record.count += 1;
    return true;
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxSnapshotBytes + 64_000 });

  const sweep = (): void => store.deleteStaleBefore(Date.now() - idleTtlMs, sessions.keys());
  sweep();
  const sweepTimer = setInterval(sweep, Math.min(idleTtlMs, 15 * 60 * 1000));
  sweepTimer.unref();

  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const session of sessions.values()) {
      for (const peer of session.peers) {
        if (!alive.has(peer.socket)) {
          peer.socket.terminate();
          continue;
        }
        alive.delete(peer.socket);
        peer.socket.ping();
      }
    }
  }, 30_000);
  heartbeat.unref();

  function live(id: string): LiveSession {
    let session = sessions.get(id);
    if (!session) {
      session = { peers: new Set(), presence: new Map(), rev: 0, lastLogged: new Map() };
      sessions.set(id, session);
    }
    if (session.cleanup) {
      clearTimeout(session.cleanup);
      session.cleanup = undefined;
    }
    return session;
  }

  function tooLarge(): ServerMessage {
    return {
      type: "error",
      code: "too-large",
      message: "Project is too large to sync live. Share it via URL instead.",
    };
  }

  /**
   * The session document, opened (and, for a session that predates op-level
   * sync, migrated from its stored snapshot) on first use.
   */
  function relayDocument(id: string, session: LiveSession, persisted: StoredSession): RelayDoc {
    if (session.doc) return session.doc;
    session.rev = persisted.rev ?? 0;
    session.doc = new RelayDoc({
      storage: store.docStorage(id),
      maxDocBytes,
      legacySnapshot: () => persisted.snapshot,
      onMigrated: () => store.clearSnapshot(id),
      onUpdate: (update, origin) => fanOutDocUpdate(id, session, update, origin),
    });
    return session.doc;
  }

  /**
   * Send one accepted document change to every other peer: as `doc-update`
   * frames to op-level clients, and as a whole `snapshot` to clients still on
   * the snapshot protocol.
   */
  function fanOutDocUpdate(
    id: string,
    session: LiveSession,
    update: Uint8Array,
    origin: string,
  ): void {
    session.rev += 1;
    const rev = session.rev;
    store.saveRev(id, rev);
    if (shouldLogDocUpdate(session.lastLogged, origin, Date.now())) {
      appendLog(id, { type: "snapshot", ts: Date.now(), rev, origin });
    }
    // Built on first use: a session may have no op-level (or no snapshot) peer.
    let frames: string[] | undefined;
    let snapshotPayload: string | null | undefined;
    for (const peer of session.peers) {
      const participant = peer.participant;
      if (!participant || participant.clientId === origin) continue;
      // Snapshot-protocol peers get the comment-mutation instead of a whole
      // project for a comment (which could overwrite their unsent edits).
      if (!participant.crdt && session.commentWrite) continue;
      if (participant.crdt) {
        frames ??= docUpdateMessages(update, origin, rev, () => randomUUID()).map((m) =>
          JSON.stringify(m),
        );
        for (const frame of frames) sendRaw(peer, frame);
        continue;
      }
      if (snapshotPayload === undefined) {
        const payload = JSON.stringify({
          type: "snapshot",
          project: session.doc!.materialize(),
          origin,
          rev,
        } satisfies ServerMessage);
        snapshotPayload = ENCODER.encode(payload).length > maxSnapshotBytes ? null : payload;
      }
      if (snapshotPayload) {
        sendRaw(peer, snapshotPayload);
      } else if (!participant.snapshotWithheld) {
        // This peer no longer holds the session's project; refuse its
        // snapshots from now on.
        participant.snapshotWithheld = true;
        send(peer, tooLarge());
      }
    }
  }

  function participants(session: LiveSession): SessionParticipant[] {
    return [...session.peers].flatMap((peer) => (peer.participant ? [peer.participant] : []));
  }

  function broadcast(session: LiveSession, message: ServerMessage, except?: Peer): void {
    const payload = JSON.stringify(message);
    for (const peer of session.peers) {
      if (peer !== except) sendRaw(peer, payload);
    }
  }

  function broadcastParticipants(session: LiveSession, except?: Peer): void {
    broadcast(
      session,
      {
        type: "participants",
        participants: participants(session).map(toWireParticipant),
      },
      except,
    );
  }

  /**
   * Record an event in the host-only session log, as the Worker does.
   *
   * Best-effort: a persistence failure must not abort the caller, which still
   * has to broadcast or tear down the peer after logging.
   *
   * @param id - The session code.
   * @param entry - The event to record.
   */
  function appendLog(id: string, entry: SessionLogEntry): void {
    try {
      store.appendSessionLog(id, entry);
    } catch {
      // The state change the entry describes has already been applied.
    }
  }

  function closePeer(id: string, session: LiveSession, peer: Peer): void {
    if (!session.peers.delete(peer)) return;
    if (peer.participant) {
      session.presence.delete(peer.participant.clientId);
      session.doc?.forget(peer.participant.clientId);
      appendLog(id, { type: "leave", ts: Date.now(), clientId: peer.participant.clientId });
    }
    broadcastParticipants(session);
    if (session.peers.size === 0) {
      session.cleanup = setTimeout(() => {
        if (session.peers.size !== 0) return;
        sessions.delete(id);
        store.delete(id);
      }, idleTtlMs);
      session.cleanup.unref();
    }
  }

  async function handleMessage(
    id: string,
    session: LiveSession,
    peer: Peer,
    raw: WebSocket.RawData,
  ): Promise<void> {
    const text = raw.toString();
    let message: ClientMessage;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      message = parsed as ClientMessage;
    } catch {
      send(peer, { type: "error", code: "bad-message", message: "Malformed JSON." });
      return;
    }

    if (message.type === "presence" && peer.participant) {
      if (!session.peers.has(peer) || peer.overflowClosed) return;
      const cursor = sanitizeCursor(message.cursor);
      const view = sanitizeView(message.view);
      const clientId = peer.participant.clientId;
      session.presence.set(clientId, { cursor, view });
      broadcast(session, { type: "presence", clientId, cursor, view }, peer);
      return;
    }

    const persisted = store.get(id);
    if (!persisted) {
      peer.socket.close(1008, "Unknown session");
      return;
    }

    if (message.type === "join") {
      if (peer.participant || peer.joining) return;
      peer.joining = true;
      let joined;
      try {
        joined = await resolveJoin({
          message,
          storedHostToken: persisted.hostToken,
          requireIdentity: persisted.requireIdentity,
          identitySecret,
          generateClientId: () => randomUUID(),
          getInvites: () => store.getInvites(id),
          isBlockedKey: (key) => store.isBlockedKey(id, key),
          claimInvite: (token) => {
            if (!store.atomicClaimInvite(id, token)) return null;
            return store.getInvites(id).find((i) => i.token === token) ?? null;
          },
          getDurableOverride: (key) => store.getDurableOverride(id, key),
          isStillConnected: () => session.peers.has(peer) && !peer.overflowClosed,
        });
      } finally {
        peer.joining = false;
      }
      if (joined.status === "aborted") return;
      if (joined.status === "error") {
        send(peer, {
          type: "error",
          code: joined.code,
          message: joined.message,
        });
        return;
      }

      peer.participant = joined.participant;
      const { role } = joined;
      appendLog(id, {
        type: "join",
        ts: Date.now(),
        clientId: peer.participant.clientId,
        identity: joined.identity,
      });
      const welcomeInvites = role === "host" ? store.getInvites(id) : undefined;
      const doc = relayDocument(id, session, persisted);
      // An op-level client fetches the project with `doc-sync`; a snapshot
      // client gets it inline, unless it outgrew what one frame may carry.
      let snapshot: unknown = null;
      let snapshotTooLarge = false;
      if (!peer.participant.crdt && !doc.project.isEmpty()) {
        snapshot = doc.materialize();
        if (ENCODER.encode(JSON.stringify(snapshot)).length > maxSnapshotBytes) {
          snapshot = null;
          snapshotTooLarge = true;
        }
      }

      send(peer, {
        type: "welcome",
        clientId: peer.participant.clientId,
        role,
        mode: persisted.mode,
        participants: participants(session).map(toWireParticipant),
        snapshot,
        presence: Object.fromEntries(session.presence),
        chat: persisted.chat,
        rev: session.rev,
        requireIdentity: persisted.requireIdentity,
        identitySupported,
        lockedLayerIds: persisted.lockedLayerIds,
        ...(welcomeInvites ? { invites: welcomeInvites } : {}),
        features: [CRDT_FEATURE],
      });
      if (snapshotTooLarge) {
        peer.participant.snapshotWithheld = true;
        send(peer, tooLarge());
      }
      broadcastParticipants(session, peer);
      return;
    }

    const participant = peer.participant;
    if (!participant) {
      send(peer, {
        type: "error",
        code: "bad-message",
        message: "Send a join message first.",
      });
      return;
    }

    const doc = relayDocument(id, session, persisted);

    if (message.type === "snapshot") {
      // A whole-project snapshot from a client on the snapshot protocol: checked
      // as before, then written into the document as the differences from it,
      // so op-level peers receive it as an ordinary update.
      // A snapshot client that was not sent the project (it outgrew the frame
      // cap) would delete everything its own project lacks.
      if (participant.snapshotWithheld) {
        send(peer, tooLarge());
        return;
      }
      const stored = doc.project.isEmpty() ? null : doc.materialize();
      const byteLength = ENCODER.encode(text).length;
      const authorization = authorizeSnapshot(
        participant,
        persisted.mode,
        byteLength,
        maxSnapshotBytes,
        stored,
        message.project,
        persisted.lockedLayerIds,
      );
      if (!authorization.ok) {
        send(peer, {
          type: "error",
          code: authorization.code,
          message: authorization.message,
        });
        if (shouldResyncRejectedSnapshot(authorization) && stored) {
          send(peer, {
            type: "snapshot",
            project: stored,
            origin: RELAY_SNAPSHOT_ORIGIN,
            rev: session.rev,
          });
        }
        return;
      }
      const project = preserveStoredComments(message.project ?? null, stored);
      if (!project || typeof project !== "object" || Array.isArray(project)) return;
      if (doc.byteSize + byteLength > maxDocBytes) {
        send(peer, tooLarge());
        return;
      }
      // Fans out through `fanOutDocUpdate`, which also advances `rev`.
      doc.writeSnapshot(project as Record<string, unknown>, participant.clientId);
      return;
    }

    if (message.type === "doc-sync") {
      doc.forget(participant.clientId);
      const frames = doc.framesFor(message.stateVector, () => randomUUID());
      if (!frames) {
        send(peer, { type: "error", code: "bad-message", message: "Malformed state vector." });
        return;
      }
      for (const frame of frames) {
        send(peer, {
          type: "doc-update",
          ...frame,
          origin: RELAY_SNAPSHOT_ORIGIN,
          rev: session.rev,
        });
      }
      send(peer, { type: "doc-synced", stateVector: doc.stateVector(), rev: session.rev });
      return;
    }

    if (message.type === "doc-update") {
      const result = doc.receive(participant.clientId, message, {
        canEdit: participantCanEdit(participant, persisted.mode),
        isHost: participant.role === "host",
        lockedLayerIds: persisted.lockedLayerIds,
      });
      if (result.status === "error") {
        const text =
          result.code === "forbidden" && participant.editOverride === false
            ? "The host has set you to view-only."
            : result.message;
        send(peer, { type: "error", code: result.code, message: text });
      } else if (result.status === "reverted") {
        send(peer, {
          type: "error",
          code: "layer-locked",
          message: `Layer "${result.layerName}" is locked by the host and cannot be modified.`,
        });
      }
      return;
    }

    if (message.type === "presence") return;

    if (message.type === "set-mode") {
      const authorization = authorizeHostAction(participant, "session mode");
      if (authorization) {
        send(peer, { type: "error", code: "forbidden", message: authorization });
        return;
      }
      const mode = normalizeMode(message.mode);
      store.saveMode(id, mode);
      appendLog(id, { type: "set-mode", ts: Date.now(), mode });
      const list = participants(session);
      if (clearParticipantOverrides(list)) broadcastParticipants(session);
      // Also clear persisted durable overrides so disconnected participants
      // don't reconnect with a stale override that contradicts the new mode.
      store.clearDurableOverrides(id);
      broadcast(session, { type: "mode", mode });
      return;
    }

    if (message.type === "set-participant-mode") {
      const authorization = authorizeHostAction(participant, "participant permissions");
      if (authorization) {
        send(peer, { type: "error", code: "forbidden", message: authorization });
        return;
      }
      if (
        typeof message.clientId === "string" &&
        setParticipantOverride(
          participant,
          participants(session),
          message.clientId,
          message.canEdit,
        )
      ) {
        const targetPeer = [...session.peers].find(
          (p) => p.participant?.clientId === message.clientId,
        );
        if (targetPeer?.participant) {
          const targetKey = getParticipantKey(targetPeer.participant);
          store.saveDurableOverride(id, targetKey, targetPeer.participant.editOverride);
          appendLog(id, {
            type: "set-participant-mode",
            ts: Date.now(),
            clientId: message.clientId,
            // The normalized value actually applied, not the raw client input.
            canEdit: targetPeer.participant.editOverride === true,
          });
        }
        broadcastParticipants(session);
      }
      return;
    }

    if (message.type === "mint-invite") {
      const authorization = authorizeHostAction(participant, "session invites");
      if (authorization) {
        send(peer, { type: "error", code: "forbidden", message: authorization });
        return;
      }
      const role: CollaborationMode = message.role === "view-only" ? "view-only" : "co-edit";
      const token = randomUUID();
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
      store.saveInvite(id, invite);
      for (const p of session.peers) {
        if (p.participant?.role === "host") {
          send(p, { type: "invite-created", invite });
        }
      }
      return;
    }

    if (message.type === "revoke-invite") {
      const authorization = authorizeHostAction(participant, "session invites");
      if (authorization) {
        send(peer, { type: "error", code: "forbidden", message: authorization });
        return;
      }
      if (typeof message.token === "string") {
        store.revokeInvite(id, message.token);
        for (const p of session.peers) {
          if (p.participant?.role === "host") {
            send(p, { type: "invite-revoked", token: message.token });
          }
        }
      }
      return;
    }

    if (message.type === "set-session-config") {
      const authorization = authorizeHostAction(participant, "session settings");
      if (authorization) {
        send(peer, { type: "error", code: "forbidden", message: authorization });
        return;
      }
      if (message.requireIdentity !== undefined) {
        const req = message.requireIdentity === true;
        // Refuse to arm a gate no one could pass: without an issuer, every
        // joiner is anonymous, so turning this on would strand the host's own
        // session with no way to undo it from a second client.
        if (req && !identitySupported) {
          send(peer, {
            type: "error",
            code: "identity-unavailable",
            message: "This relay has no sign-in provider configured.",
          });
          return;
        }
        store.saveSessionConfig(id, req);
        broadcast(session, { type: "session-config", requireIdentity: req });
      }
      return;
    }

    if (message.type === "set-layer-locks") {
      const authorization = authorizeHostAction(participant, "layer locks");
      if (authorization) {
        send(peer, { type: "error", code: "forbidden", message: authorization });
        return;
      }
      const lockedLayerIds = Array.isArray(message.lockedLayerIds)
        ? message.lockedLayerIds.filter((item: unknown): item is string => typeof item === "string")
        : [];
      store.saveLayerLocks(id, lockedLayerIds);
      broadcast(session, { type: "layer-locks", lockedLayerIds });
      return;
    }

    if (message.type === "kick-participant") {
      const authorization = authorizeHostAction(participant, "participant moderation");
      if (authorization) {
        send(peer, { type: "error", code: "forbidden", message: authorization });
        return;
      }
      if (typeof message.clientId !== "string") return;
      const targetPeer = [...session.peers].find(
        (p) => p.participant?.clientId === message.clientId,
      );
      if (!targetPeer || targetPeer.participant?.role === "host") return;

      send(targetPeer, {
        type: "kicked",
        reason: message.reason ?? "Kicked by session host.",
      });
      targetPeer.socket.close(4000, "Kicked by host");
      return;
    }

    if (message.type === "block-participant") {
      const authorization = authorizeHostAction(participant, "participant moderation");
      if (authorization) {
        send(peer, { type: "error", code: "forbidden", message: authorization });
        return;
      }
      if (typeof message.clientId !== "string") return;
      const targetPeer = [...session.peers].find(
        (p) => p.participant?.clientId === message.clientId,
      );
      if (!targetPeer || !targetPeer.participant || targetPeer.participant.role === "host") return;

      const targetKey = getParticipantKey(targetPeer.participant);
      store.blockKey(id, targetKey);

      send(targetPeer, {
        type: "kicked",
        reason: message.reason ?? "Blocked by session host.",
      });
      targetPeer.socket.close(4001, "Blocked by host");
      return;
    }

    if (message.type === "chat") {
      const prepared = prepareChatMessage({
        participant,
        message,
        now: Date.now(),
        generateId: () => randomUUID(),
      });
      if (!prepared) return;
      participant.lastChatTs = prepared.nextLastChatTs;
      const { chatMessage } = prepared;
      const { history } = appendBoundedChatHistory(persisted.chat, chatMessage);
      store.saveChat(id, history);
      broadcast(session, { type: "chat", message: chatMessage });
      return;
    }

    if (message.type === "comment-mutation") {
      // Shape is validated before the permission check, matching the Worker
      // (workers/collab/src/session.ts). Checking permission first made a
      // malformed frame from a view-only guest answer `forbidden` here and
      // `bad-message` there -- an observable difference between two relays this
      // package exists to keep in lockstep.
      const action = message.action;
      if (!action || typeof action !== "object") {
        send(peer, {
          type: "error",
          code: "bad-message",
          message: "Missing or invalid comment-mutation action.",
        });
        return;
      }
      let sanitized: typeof action;
      if (action.type === "add") {
        const comment = validateComment(action.comment);
        if (!comment) {
          send(peer, { type: "error", code: "bad-message", message: "Invalid comment payload." });
          return;
        }
        sanitized = { type: "add", comment };
      } else if (action.type === "reply") {
        const reply = validateReply(action.reply);
        if (!isBoundedId(action.commentId) || !reply) {
          send(peer, { type: "error", code: "bad-message", message: "Invalid reply payload." });
          return;
        }
        sanitized = { type: "reply", commentId: action.commentId, reply };
      } else if (action.type === "toggle-resolve" || action.type === "delete") {
        if (!isBoundedId(action.commentId)) {
          send(peer, { type: "error", code: "bad-message", message: "Invalid comment target." });
          return;
        }
        sanitized =
          action.type === "delete"
            ? { type: "delete", commentId: action.commentId }
            : {
                type: "toggle-resolve",
                commentId: action.commentId,
                ...(action.resolved !== undefined ? { resolved: action.resolved === true } : {}),
              };
      } else {
        send(peer, {
          type: "error",
          code: "bad-message",
          message: "Unsupported comment-mutation action type.",
        });
        return;
      }
      if (!participantCanEdit(participant, persisted.mode)) {
        send(peer, {
          type: "error",
          code: "forbidden",
          message: "You are in view-only mode and cannot comment.",
        });
        return;
      }
      const now = Date.now();
      if (
        participant.lastCommentTs !== undefined &&
        now - participant.lastCommentTs < MIN_COMMENT_INTERVAL_MS
      )
        return;
      participant.lastCommentTs = now;
      const project: Record<string, unknown> = {};
      const storedComments = doc.project.fields.get("comments");
      // Non-object entries are filtered out, not just checked for array-ness.
      // Project content is opaque and unvalidated, so a client can plant `null`
      // into project.comments with an ordinary edit; every `.id` read below
      // would then throw and leave commenting permanently broken for that
      // session. The Worker tolerates the same corrupt data, so this is parity
      // as well as robustness.
      const comments = (Array.isArray(storedComments) ? storedComments : []).filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
      );
      if (sanitized.type === "add") {
        const comment = sanitized.comment as Record<string, unknown>;
        if (
          !comments.some((existing) => existing.id === comment.id) &&
          comments.length >= MAX_COMMENTS_PER_SESSION
        ) {
          send(peer, {
            type: "error",
            code: "bad-message",
            message: "Comment limit reached for this session.",
          });
          return;
        }
        project.comments = comments.some((existing) => existing.id === comment.id)
          ? comments
          : [...comments, comment];
      } else if (sanitized.type === "reply") {
        const target = comments.find((comment) => comment.id === sanitized.commentId);
        if (!target) {
          send(peer, { type: "error", code: "bad-message", message: "Invalid reply target." });
          return;
        }
        const replies = (Array.isArray(target.replies) ? target.replies : []).filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
        );
        if (replies.length >= MAX_REPLIES_PER_COMMENT) {
          send(peer, {
            type: "error",
            code: "bad-message",
            message: "Reply limit reached for this comment.",
          });
          return;
        }
        const reply = sanitized.reply as Record<string, unknown>;
        project.comments = comments.map((comment) =>
          comment.id !== sanitized.commentId || replies.some((existing) => existing.id === reply.id)
            ? comment
            : { ...comment, replies: [...replies, reply] },
        );
      } else if (sanitized.type === "toggle-resolve") {
        project.comments = comments.map((comment) =>
          comment.id === sanitized.commentId
            ? {
                ...comment,
                resolved: sanitized.resolved !== undefined ? sanitized.resolved : !comment.resolved,
              }
            : comment,
        );
      } else {
        project.comments = comments.filter((comment) => comment.id !== sanitized.commentId);
      }
      // The Worker bounds the document the same way before persisting it
      // (workers/collab/src/session.ts). Without this the per-comment caps still
      // permit a worst case orders of magnitude past the document ceiling.
      const grows = sanitized.type === "add" || sanitized.type === "reply";
      // byteSize already counts the stored list; charge only the growth.
      const added = grows
        ? ENCODER.encode(JSON.stringify(project.comments)).length -
          ENCODER.encode(JSON.stringify(comments)).length
        : 0;
      if (grows && doc.byteSize + added > maxDocBytes) {
        send(peer, {
          type: "error",
          code: "bad-message",
          message: "Project is too large to store this comment.",
        });
        return;
      }
      session.commentWrite = true;
      try {
        doc.setField("comments", project.comments);
      } finally {
        session.commentWrite = false;
      }
      broadcast(session, { type: "comment-mutation", action: sanitized }, peer);
    }
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "OPTIONS") return json(response, 204, null);
    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET")
      // `identitySupported` lets the client hide the "require a signed-in
      // account" option before it ever tries to create a session.
      return json(response, 200, { ok: true, service: "geolibre-collab", identitySupported });
    if (url.pathname === "/sessions" && request.method === "POST") {
      const origin = request.headers["origin"] ?? request.headers["referer"];
      if (!isAllowedOrigin(origin, process.env.ALLOWED_ORIGINS)) {
        return json(response, 403, { error: "Forbidden origin" });
      }

      const rawXff = trustProxy
        ? (request.headers["x-forwarded-for"] as string | undefined)
        : undefined;
      // Read the entry `trustProxyHops` from the right: the one appended by the
      // nearest trusted proxy. When fewer entries are present, fall back to the
      // socket address rather than trusting a leftmost, client-spoofable value.
      const xffParts = rawXff
        ?.split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const clientIp =
        (xffParts && xffParts.length >= trustProxyHops
          ? xffParts[xffParts.length - trustProxyHops]
          : undefined) ||
        request.socket.remoteAddress ||
        "unknown";
      if (!checkRateLimit(clientIp, 10, 60_000)) {
        return json(response, 429, { error: "Too many session creation requests" });
      }

      // Refuse on the declared length before any handler is registered, so an
      // oversized upload cannot hold the connection open while it trickles in.
      // The byte counter below still runs, for clients that omit or understate
      // the header.
      const declaredLength = Number(request.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_SESSION_BODY_BYTES) {
        request.pause();
        response.on("finish", () => request.destroy());
        return json(response, 413, { error: "Request body too large." });
      }
      let raw = "";
      let rawBytes = 0;
      let aborted = false;
      request.setEncoding("utf8");
      // An unhandled "error" on the request stream (a client aborting mid-upload)
      // throws and would terminate the process.
      request.on("error", () => {
        aborted = true;
      });
      request.on("data", (chunk) => {
        if (aborted) return;
        // Counted in UTF-8 bytes *including* this chunk, and checked before the
        // append: testing the running length first would accept one final chunk
        // of any size once the total was still under the cap.
        rawBytes += Buffer.byteLength(chunk);
        if (rawBytes <= MAX_SESSION_BODY_BYTES) {
          raw += chunk;
          return;
        }
        // Stopping at the cap but continuing to read let a client stream
        // unbounded data at us; destroy the request instead.
        aborted = true;
        // Pause rather than destroy immediately: destroying the request tears
        // down the socket before the 413 can flush, and the client sees a
        // connection reset instead of the status. Stop reading, answer, then
        // drop the connection once the response is on the wire.
        request.pause();
        response.on("finish", () => request.destroy());
        json(response, 413, { error: "Request body too large." });
      });
      request.on("end", () => {
        if (aborted) return;
        let requested: unknown = {};
        try {
          requested = raw ? JSON.parse(raw) : {};
        } catch {
          // Match the Worker: malformed/empty input uses defaults.
        }
        const reqObj = requested as { mode?: CollaborationMode; requireIdentity?: boolean } | null;
        const mode = normalizeMode(reqObj?.mode);
        const requireIdentity = reqObj?.requireIdentity === true;
        // Fail the create rather than silently downgrading: a host who asked
        // for a sign-in gate should hear that this relay has no issuer, not
        // discover it by watching anonymous guests walk in.
        if (requireIdentity && !identitySupported) {
          return json(response, 400, {
            error: "This relay has no sign-in provider configured.",
          });
        }
        for (let attempt = 0; attempt < 5; attempt++) {
          const sessionId = randomCode();
          const hostToken = randomToken();
          if (store.create(sessionId, hostToken, mode, requireIdentity))
            return json(response, 200, { sessionId, hostToken, mode, requireIdentity });
        }
        return json(response, 503, {
          error: "Could not allocate a session code. Please try again.",
        });
      });
      return;
    }
    // Host-only session log: GET downloads it, DELETE clears it (the session
    // and its snapshot are untouched). The host token is a bearer credential, so
    // it travels in the Authorization header rather than the query string. An
    // unknown session answers 403 like a wrong token, as on the Worker, so the
    // endpoint does not reveal which session codes exist.
    const logMatch = url.pathname.match(/^\/sessions\/([^/]+)\/log$/);
    if (logMatch && (request.method === "GET" || request.method === "DELETE")) {
      const sessionId = logMatch[1];
      const hostToken = store.getHostToken(sessionId) ?? "";
      const clientToken = bearerToken(request.headers.authorization);
      if (!hostToken || !clientToken || !timingSafeEqual(hostToken, clientToken)) {
        return json(response, 403, { error: "Forbidden" });
      }
      if (request.method === "DELETE") {
        store.clearSessionLog(sessionId);
        response.writeHead(204, CORS_HEADERS);
        response.end();
        return;
      }
      return json(response, 200, store.getSessionLog(sessionId), { "cache-control": "no-store" });
    }
    json(response, 404, { error: "Not found" });
  });

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    // A raw net.Socket with no "error" listener throws on the next TCP error,
    // which is an uncaught exception that stops the relay. This is the pre-auth
    // path, so it takes whatever port scanners and stray health checks send,
    // and the reject branch below writes to the socket and destroys it.
    socket.on("error", () => socket.destroy());
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);
    if (request.method !== "GET" || !match || !store.get(match[1])) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const id = match[1];
    wss.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
      const session = live(id);
      const peer: Peer = { socket: websocket, pendingFrames: 0 };
      session.peers.add(peer);
      alive.add(websocket);
      websocket.on("pong", () => alive.add(websocket));
      websocket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          send(peer, {
            type: "error",
            code: "bad-message",
            message: "Binary frames are not supported.",
          });
          return;
        }
        if (peer.pendingFrames >= MAX_PENDING_FRAMES) {
          peer.overflowClosed = true;
          send(peer, {
            type: "error",
            code: "bad-message",
            message: "Too many queued messages; reconnecting.",
          });
          peer.socket.close(1008, "Too many queued messages");
          return;
        }
        peer.pendingFrames += 1;
        // Defence in depth: a throw (or rejection) here would otherwise be an
        // uncaught exception that stops the whole relay. No single session's
        // frame should be able to do that to the others.
        peer.queue = (peer.queue ?? Promise.resolve())
          .then(() => {
            if (peer.overflowClosed) return;
            return handleMessage(id, session, peer, raw);
          })
          .catch(() => {
            send(peer, {
              type: "error",
              code: "bad-message",
              message: "Could not handle message.",
            });
          })
          .finally(() => {
            peer.pendingFrames = Math.max(0, peer.pendingFrames - 1);
          });
      });
      websocket.on("close", () => closePeer(id, session, peer));
      websocket.on("error", () => closePeer(id, session, peer));
    });
  });

  return {
    server,
    store,
    close: async () => {
      clearInterval(sweepTimer);
      clearInterval(heartbeat);
      const open: WebSocket[] = [];
      for (const session of sessions.values()) {
        if (session.cleanup) clearTimeout(session.cleanup);
        for (const peer of session.peers) {
          peer.socket.close(1001, "Server shutting down");
          open.push(peer.socket);
        }
      }
      // close() only *starts* the closing handshake. server.close() waits for
      // every connection to end, so a client that never answers would hang
      // shutdown indefinitely.
      const grace = setTimeout(() => {
        for (const socket of open) socket.terminate();
      }, 1000);
      grace.unref();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      clearTimeout(grace);
      wss.close();
      store.close();
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const relay = createRelay();
  const port = positive(process.env.PORT, 8787);
  relay.server.listen(port, process.env.HOST ?? "0.0.0.0", () => {
    console.log(`GeoLibre collaboration relay listening on port ${port}`);
  });
  // Without these, `docker stop` (and a Kubernetes pod eviction) terminates the
  // process on the default SIGTERM action, so relay.close() never runs: peers
  // get a raw socket drop instead of a 1001 close, and the SQLite handle is not
  // closed cleanly. Nothing outside the tests called close() before this.
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      relay.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}
