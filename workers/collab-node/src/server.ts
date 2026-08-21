import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CHAT_HISTORY_LIMIT,
  MAX_CHAT_STORAGE_BYTES,
  MAX_CHAT_TEXT_LENGTH,
  MAX_COMMENTS_PER_SESSION,
  MAX_REPLIES_PER_COMMENT,
  MAX_SNAPSHOT_BYTES,
  MIN_COMMENT_INTERVAL_MS,
  MIN_CHAT_INTERVAL_MS,
  authorizeHostAction,
  authorizeSnapshot,
  clearParticipantOverrides,
  diffLockedLayers,
  getParticipantKey,
  isIdentityConfigured,
  normalizeMode,
  participantCanEdit,
  preserveStoredComments,
  sanitizeCursor,
  sanitizeDisplayName,
  sanitizeColor,
  sanitizeView,
  setParticipantOverride,
  toWireParticipant,
  validateComment,
  validateReply,
  verifyIdentityToken,
  isBoundedId,
  type ClientMessage,
  type CollabChatMessage,
  type CollabInvite,
  type CollaborationMode,
  type CollaborationRole,
  type ParticipantIdentity,
  type PresenceEntry,
  type ServerMessage,
  type SessionParticipant,
} from "@geolibre/collab-core";
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

function isAllowedOrigin(
  originHeader: string | undefined,
  envAllowed = process.env.ALLOWED_ORIGINS,
): boolean {
  if (!originHeader) return true;
  const allowedList = envAllowed
    ? envAllowed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [
        "https://geolibre.app",
        "https://web.geolibre.app",
        "https://viewer.geolibre.app",
        "https://studio.geolibre.app",
        "https://collab.geolibre.app",
        "http://localhost",
        "http://127.0.0.1",
        "tauri://localhost",
      ];

  try {
    const originUrl = new URL(originHeader);
    const host = originUrl.hostname;
    if (!envAllowed) {
      if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) return true;
      const previewSuffix = ".geolibre-preview.pages.dev";
      const previewLabel = host.endsWith(previewSuffix) ? host.slice(0, -previewSuffix.length) : "";
      if (
        originUrl.protocol === "https:" &&
        !originUrl.port &&
        previewLabel &&
        !previewLabel.includes(".")
      ) {
        return true;
      }
    }
    return allowedList.some((allowed) => {
      if (allowed === "*") return true;
      try {
        const allowedUrl = new URL(allowed);
        return originUrl.origin === allowedUrl.origin;
      } catch {
        return originHeader === allowed || host === allowed;
      }
    });
  } catch {
    return false;
  }
}

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
}

interface LiveSession {
  peers: Set<Peer>;
  presence: Map<string, PresenceEntry>;
  cleanup?: NodeJS.Timeout;
}

export interface RelayOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  maxSnapshotBytes?: number;
  idleTtlMs?: number;
  trustProxy?: boolean;
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

function send(peer: Peer, message: ServerMessage): void {
  if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(message));
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
  });
  response.end(JSON.stringify(body));
}

export function createRelay(options: RelayOptions = {}): {
  server: Server;
  store: SessionStore;
  close: () => Promise<void>;
} {
  const dbPath = options.dbPath ?? process.env.COLLAB_DB_PATH ?? "./data/collab.sqlite";
  const maxSnapshotBytes =
    options.maxSnapshotBytes ?? positive(process.env.COLLAB_MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_BYTES);
  const idleTtlMs =
    options.idleTtlMs ?? positive(process.env.COLLAB_IDLE_TTL_MS, DEFAULT_IDLE_TTL_MS);
  const trustProxy =
    options.trustProxy ?? (process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1");
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
      session = { peers: new Set(), presence: new Map() };
      sessions.set(id, session);
    }
    if (session.cleanup) {
      clearTimeout(session.cleanup);
      session.cleanup = undefined;
    }
    return session;
  }

  function participants(session: LiveSession): SessionParticipant[] {
    return [...session.peers].flatMap((peer) => (peer.participant ? [peer.participant] : []));
  }

  function broadcast(session: LiveSession, message: ServerMessage, except?: Peer): void {
    for (const peer of session.peers) if (peer !== except) send(peer, message);
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

  function closePeer(id: string, session: LiveSession, peer: Peer): void {
    if (!session.peers.delete(peer)) return;
    if (peer.participant) session.presence.delete(peer.participant.clientId);
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
      if (peer.participant) return;
      let role: CollaborationRole =
        message.hostToken && persisted.hostToken && message.hostToken === persisted.hostToken
          ? "host"
          : "guest";

      let inviteToken: string | undefined = undefined;
      let matchedInvite: CollabInvite | undefined = undefined;
      if (role === "guest" && message.inviteToken && typeof message.inviteToken === "string") {
        const invites = store.getInvites(id);
        const inv = invites.find((i) => i.token === message.inviteToken && !i.revoked);
        if (inv && (!inv.maxUses || inv.useCount < inv.maxUses)) {
          inviteToken = inv.token;
          matchedInvite = inv;
        }
      }

      // Signature-checked against the configured issuer secret, so `identity`
      // is only ever non-null for a credential this deployment actually minted.
      // With no secret configured it is null for every token, making every
      // joiner anonymous rather than trusting self-reported claims.
      const identity: ParticipantIdentity | null = await verifyIdentityToken(
        message.identityToken,
        identitySecret,
      );

      if (persisted.requireIdentity && !identity && role !== "host") {
        send(peer, {
          type: "error",
          code: "identity-required",
          message: "Sign-in required to join this session.",
        });
        return;
      }

      const socketClientId = randomUUID();
      const joiningParticipant: SessionParticipant = {
        clientId: socketClientId,
        displayName: identity ? identity.username : sanitizeDisplayName(message.displayName),
        color: sanitizeColor(message.color),
        role,
        identity,
        inviteToken,
      };
      const participantKey = getParticipantKey(joiningParticipant);

      if (store.isBlockedKey(id, participantKey)) {
        send(peer, {
          type: "error",
          code: "forbidden",
          message: "You have been blocked from this session by the host.",
        });
        return;
      }

      const durableOverride = store.getDurableOverride(id, participantKey);
      let initialOverride: boolean | undefined = undefined;
      if (durableOverride !== undefined) {
        initialOverride = durableOverride;
      } else if (matchedInvite) {
        initialOverride = matchedInvite.role === "co-edit";
      }

      if (matchedInvite) {
        // Use an atomic SQL UPDATE to close the TOCTOU window: the initial
        // maxUses check (line 312) happened before `await verifyIdentityToken`,
        // and another join could have consumed the invite in the meantime.
        if (!store.atomicClaimInvite(id, matchedInvite.token)) {
          // Invite was consumed or revoked between the initial check and now.
          matchedInvite = undefined;
          inviteToken = undefined;
        }
      }

      peer.participant = {
        clientId: socketClientId,
        displayName: identity ? identity.username : sanitizeDisplayName(message.displayName),
        color: sanitizeColor(message.color),
        role,
        ...(initialOverride !== undefined ? { editOverride: initialOverride } : {}),
        identity,
        inviteToken,
      };

      const welcomeInvites = role === "host" ? store.getInvites(id) : undefined;

      send(peer, {
        type: "welcome",
        clientId: peer.participant.clientId,
        role,
        mode: persisted.mode,
        participants: participants(session).map(toWireParticipant),
        snapshot: persisted.snapshot,
        presence: Object.fromEntries(session.presence),
        chat: persisted.chat,
        rev: persisted.rev,
        requireIdentity: persisted.requireIdentity,
        identitySupported,
        lockedLayerIds: persisted.lockedLayerIds,
        ...(welcomeInvites ? { invites: welcomeInvites } : {}),
      });
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

    if (message.type === "snapshot") {
      const authorization = authorizeSnapshot(
        participant,
        persisted.mode,
        ENCODER.encode(text).length,
        maxSnapshotBytes,
        persisted.snapshot,
        message.project,
        persisted.lockedLayerIds,
      );
      if (!authorization.ok) {
        send(peer, {
          type: "error",
          code: authorization.code,
          message: authorization.message,
        });
        return;
      }
      const project = preserveStoredComments(message.project ?? null, persisted.snapshot);
      const nextRev = (persisted.rev ?? 0) + 1;
      store.saveSnapshot(id, project, nextRev);
      persisted.rev = nextRev;
      broadcast(
        session,
        { type: "snapshot", project, origin: participant.clientId, rev: nextRev },
        peer,
      );
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
      const chatText =
        typeof message.text === "string" ? message.text.trim().slice(0, MAX_CHAT_TEXT_LENGTH) : "";
      if (!chatText) return;
      const now = Date.now();
      if (
        participant.lastChatTs !== undefined &&
        now - participant.lastChatTs < MIN_CHAT_INTERVAL_MS
      )
        return;
      participant.lastChatTs = now;
      const chatMessage: CollabChatMessage = {
        id: randomUUID(),
        clientId: participant.clientId,
        displayName: participant.displayName,
        color: participant.color,
        text: chatText,
        coordinate: sanitizeCursor(message.coordinate),
        ts: now,
      };
      let chat = [...persisted.chat, chatMessage].slice(-CHAT_HISTORY_LIMIT);
      while (
        chat.length > 1 &&
        ENCODER.encode(JSON.stringify(chat)).length > MAX_CHAT_STORAGE_BYTES
      )
        chat = chat.slice(1);
      store.saveChat(id, chat);
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
      const project =
        persisted.snapshot &&
        typeof persisted.snapshot === "object" &&
        !Array.isArray(persisted.snapshot)
          ? { ...(persisted.snapshot as Record<string, unknown>) }
          : {};
      // Non-object entries are filtered out, not just checked for array-ness.
      // Snapshot content is opaque and unvalidated, so a client can plant `null`
      // into project.comments with an ordinary snapshot frame; every `.id` read
      // below would then throw and leave commenting permanently broken for that
      // session. The Worker tolerates the same corrupt data, so this is parity
      // as well as robustness.
      const comments = (Array.isArray(project.comments) ? project.comments : []).filter(
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
      // The Worker bounds the mutated project the same way before persisting it
      // (workers/collab/src/session.ts). Without this the per-comment caps still
      // permit a worst case orders of magnitude past the snapshot ceiling, so
      // the Node relay would store and broadcast a project the Worker would have
      // refused.
      if (ENCODER.encode(JSON.stringify(project)).length > maxSnapshotBytes) {
        send(peer, {
          type: "error",
          code: "bad-message",
          message: "Project is too large to store this comment.",
        });
        return;
      }
      store.saveProjectState(id, project);
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
      if (!isAllowedOrigin(origin)) {
        return json(response, 403, { error: "Forbidden origin" });
      }

      const rawXff = trustProxy
        ? (request.headers["x-forwarded-for"] as string | undefined)
        : undefined;
      const clientIp = rawXff?.split(",")[0].trim() || request.socket.remoteAddress || "unknown";
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
      const peer: Peer = { socket: websocket };
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
        // Defence in depth: a throw (or rejection) here would otherwise be an
        // uncaught exception that stops the whole relay. No single session's
        // frame should be able to do that to the others.
        peer.queue = (peer.queue ?? Promise.resolve())
          .then(() => handleMessage(id, session, peer, raw))
          .catch(() => {
            send(peer, {
              type: "error",
              code: "bad-message",
              message: "Could not handle message.",
            });
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
