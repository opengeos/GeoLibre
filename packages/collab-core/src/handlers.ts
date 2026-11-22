import type {
  ClientMessage,
  CollabChatMessage,
  CollabInvite,
  CollaborationRole,
  ParticipantIdentity,
} from "./protocol";
import { timingSafeEqual, verifyIdentityToken } from "./identity";
import {
  CHAT_HISTORY_LIMIT,
  MAX_CHAT_STORAGE_BYTES,
  MAX_CHAT_TEXT_LENGTH,
  MIN_CHAT_INTERVAL_MS,
  getParticipantKey,
  sanitizeColor,
  sanitizeCursor,
  sanitizeDisplayName,
  type SessionParticipant,
} from "./session";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://geolibre.app",
  "https://web.geolibre.app",
  "https://viewer.geolibre.app",
  "https://studio.geolibre.app",
  "https://collab.geolibre.app",
  "http://localhost",
  "http://127.0.0.1",
  "tauri://localhost",
] as const;

interface UrlLike {
  readonly hostname: string;
  readonly origin: string;
  readonly port: string;
  readonly protocol: string;
}

interface RuntimeGlobals {
  URL?: new (input: string) => UrlLike;
  TextEncoder?: new () => { encode(input: string): Uint8Array };
}

function runtimeGlobals(): RuntimeGlobals {
  return globalThis as unknown as RuntimeGlobals;
}

let cachedEncoder: { encode(input: string): Uint8Array } | null = null;
function utf8ByteLength(value: string): number {
  if (!cachedEncoder) {
    const Encoder = runtimeGlobals().TextEncoder;
    if (!Encoder) throw new Error("TextEncoder is unavailable");
    cachedEncoder = new Encoder();
  }
  return cachedEncoder.encode(value).length;
}

/**
 * Shared Origin/Referer allowlist check for `POST /sessions` across both the
 * Cloudflare Worker and Node collaboration relays.
 */
export function isAllowedOrigin(
  originHeader: string | null | undefined,
  envAllowed?: string,
): boolean {
  if (!originHeader) return true;
  const UrlCtor = runtimeGlobals().URL;
  if (!UrlCtor) return false;

  const allowedList: readonly string[] = envAllowed
    ? envAllowed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;

  try {
    const originUrl = new UrlCtor(originHeader);
    const host = originUrl.hostname;
    if (!envAllowed) {
      if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) {
        return true;
      }
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
        const allowedUrl = new UrlCtor(allowed);
        // Never compare opaque origins by their serialized `"null"` string
        // (which would let any custom scheme match `tauri://localhost`).
        if (originUrl.origin !== "null" && allowedUrl.origin !== "null") {
          return originUrl.origin === allowedUrl.origin;
        }
        return (
          originUrl.protocol === allowedUrl.protocol &&
          originUrl.hostname !== "" &&
          originUrl.hostname === allowedUrl.hostname &&
          originUrl.port === allowedUrl.port
        );
      } catch {
        return originHeader === allowed || (host !== "" && host === allowed);
      }
    });
  } catch {
    return false;
  }
}

export interface ResolveJoinOptions {
  message: Extract<ClientMessage, { type: "join" }>;
  storedHostToken: string | null | undefined;
  requireIdentity: boolean;
  identitySecret: string | undefined;
  generateClientId: () => string;
  getInvites: () => CollabInvite[];
  isBlockedKey: (key: string) => boolean;
  /**
   * Re-validate and atomically claim the matched invite token after the async
   * identity verification step, returning the claimed invite or `null` if it
   * was consumed or revoked in the meantime.
   */
  claimInvite: (token: string) => CollabInvite | null;
  getDurableOverride: (key: string) => boolean | undefined;
  /**
   * Optional liveness check invoked right after `await verifyIdentityToken`
   * so transports that deliver frames over an open socket can abort cleanly if
   * the connection closed while verifying.
   */
  isStillConnected?: () => boolean;
}

export type ResolveJoinResult =
  | { status: "aborted" }
  | { status: "error"; code: "identity-required" | "forbidden"; message: string }
  | {
      status: "ok";
      participant: SessionParticipant;
      identity: ParticipantIdentity | null;
      role: CollaborationRole;
    };

/**
 * Shared `join` state transition for both collaboration relays: resolves host
 * vs guest role, verifies identity tokens, enforces `requireIdentity` and
 * moderation blocks, closes the post-await invite claim TOCTOU window, and
 * derives the participant's durable edit override.
 */
export async function resolveJoin(options: ResolveJoinOptions): Promise<ResolveJoinResult> {
  const { message, storedHostToken, requireIdentity, identitySecret } = options;

  const role: CollaborationRole =
    message.hostToken && storedHostToken && timingSafeEqual(message.hostToken, storedHostToken)
      ? "host"
      : "guest";

  let inviteToken: string | undefined;
  let matchedInvite: CollabInvite | undefined;
  if (role === "guest" && message.inviteToken && typeof message.inviteToken === "string") {
    const invites = options.getInvites();
    const inv = invites.find((i) => i.token === message.inviteToken && !i.revoked);
    if (inv && (!inv.maxUses || inv.useCount < inv.maxUses)) {
      inviteToken = inv.token;
      matchedInvite = inv;
    }
  }

  // Signature-checked against the configured issuer secret, so `identity` is
  // only ever non-null for a credential this deployment actually minted.
  const identity: ParticipantIdentity | null = await verifyIdentityToken(
    message.identityToken,
    identitySecret,
  );
  if (options.isStillConnected && !options.isStillConnected()) {
    return { status: "aborted" };
  }

  if (requireIdentity && !identity && role !== "host") {
    return {
      status: "error",
      code: "identity-required",
      message: "Sign-in required to join this session.",
    };
  }

  const socketClientId = options.generateClientId();
  const initialInviteShared = matchedInvite ? matchedInvite.maxUses !== 1 : undefined;
  const displayName = identity ? identity.username : sanitizeDisplayName(message.displayName);
  const color = sanitizeColor(message.color);
  const joiningParticipant: SessionParticipant = {
    clientId: socketClientId,
    displayName,
    color,
    role,
    identity,
    inviteToken,
    ...(initialInviteShared ? { inviteShared: true } : {}),
  };
  const participantKey = getParticipantKey(joiningParticipant);

  if (options.isBlockedKey(participantKey)) {
    return {
      status: "error",
      code: "forbidden",
      message: "You have been blocked from this session by the host.",
    };
  }

  if (matchedInvite) {
    // Re-validate and claim the invite AFTER `await verifyIdentityToken` to
    // close the TOCTOU window between concurrent joins on limited-use invites.
    const claimed = options.claimInvite(matchedInvite.token);
    if (!claimed) {
      matchedInvite = undefined;
      inviteToken = undefined;
    } else {
      matchedInvite = claimed;
    }
  }

  // Resolve durable override and initial edit rights AFTER claiming the invite,
  // using the participant's final post-claim key, so a claim loser never
  // inherits an invite-keyed override.
  const finalInviteShared = matchedInvite ? matchedInvite.maxUses !== 1 : undefined;
  const finalParticipantKey = getParticipantKey({
    ...joiningParticipant,
    inviteToken,
    inviteShared: finalInviteShared,
  });
  const durableOverride = options.getDurableOverride(finalParticipantKey);
  let initialOverride: boolean | undefined;
  if (durableOverride !== undefined) {
    initialOverride = durableOverride;
  } else if (matchedInvite) {
    initialOverride = matchedInvite.role === "co-edit";
  }

  const participant: SessionParticipant = {
    clientId: socketClientId,
    displayName,
    color,
    role,
    ...(initialOverride !== undefined ? { editOverride: initialOverride } : {}),
    identity,
    inviteToken,
    ...(finalInviteShared ? { inviteShared: true } : {}),
  };

  return { status: "ok", participant, identity, role };
}

export interface PrepareChatOptions {
  participant: SessionParticipant;
  message: Extract<ClientMessage, { type: "chat" }>;
  now: number;
  generateId: () => string;
}

export interface PreparedChatMessage {
  chatMessage: CollabChatMessage;
  nextLastChatTs: number;
}

/**
 * Shared `chat` validation, per-participant rate limiting, and message
 * construction. Returns `null` when the message is empty or rate-limited.
 */
export function prepareChatMessage(options: PrepareChatOptions): PreparedChatMessage | null {
  const { participant, message, now, generateId } = options;
  const text =
    typeof message.text === "string" ? message.text.trim().slice(0, MAX_CHAT_TEXT_LENGTH) : "";
  if (!text) return null;
  if (participant.lastChatTs !== undefined && now - participant.lastChatTs < MIN_CHAT_INTERVAL_MS) {
    return null;
  }
  const chatMessage: CollabChatMessage = {
    id: generateId(),
    clientId: participant.clientId,
    displayName: participant.displayName,
    color: participant.color,
    text,
    coordinate: sanitizeCursor(message.coordinate),
    ts: now,
  };
  return { chatMessage, nextLastChatTs: now };
}

/**
 * Append a chat message to history and trim to both entry count and UTF-8
 * serialized byte budget in O(n) time.
 */
export function appendBoundedChatHistory(
  history: readonly CollabChatMessage[],
  chatMessage: CollabChatMessage,
  maxEntries = CHAT_HISTORY_LIMIT,
  maxBytes = MAX_CHAT_STORAGE_BYTES,
): { history: CollabChatMessage[]; serialized: string } {
  const trimmed = [...history, chatMessage].slice(-maxEntries);
  let start = 0;
  let byteLen = utf8ByteLength(JSON.stringify(trimmed));
  while (trimmed.length - start > 1 && byteLen > maxBytes) {
    byteLen -= utf8ByteLength(JSON.stringify(trimmed[start])) + 1;
    start += 1;
  }
  const bounded = start > 0 ? trimmed.slice(start) : trimmed;
  return { history: bounded, serialized: JSON.stringify(bounded) };
}
