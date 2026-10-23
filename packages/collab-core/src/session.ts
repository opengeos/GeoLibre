import type {
  CollabChatMessage,
  CollabCursor,
  CollabInvite,
  CollabParticipant,
  CollabView,
  CollaborationMode,
  CollaborationRole,
  ParticipantIdentity,
} from "./protocol";
import { finite, HEX_COLOR_RE } from "./internal/validate";

// Large in-memory/plugin datasets are embedded as GeoJSON in collaboration
// snapshots so peers can render them without the originating plugin or local
// file. Keep this comfortably below Cloudflare's 32 MiB ceiling on a received
// WebSocket message while allowing representative multi-layer datasets. Note
// this is only the transport bound: a Durable Object caps a stored SQLite
// string at 2 MB, so `workers/collab` splits a snapshot across rows.
export const MAX_SNAPSHOT_BYTES = 10_000_000;
export const EMPTY_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_CHAT_TEXT_LENGTH = 2000;
export const CHAT_HISTORY_LIMIT = 50;
export const MAX_CHAT_STORAGE_BYTES = 100_000;
/** Host-visible session log: bounded by entry count and serialized bytes. */
export const SESSION_LOG_LIMIT = 5000;
export const MAX_SESSION_LOG_STORAGE_BYTES = 100_000;
export const MIN_CHAT_INTERVAL_MS = 250;

/**
 * Transport-neutral state attached to one connection. Adapters may keep this
 * in memory (Node) or serialize it onto a hibernatable socket (Cloudflare).
 */
export interface SessionParticipant {
  clientId: string;
  displayName: string;
  color: string;
  role: CollaborationRole;
  editOverride?: boolean;
  identity?: ParticipantIdentity | null;
  inviteToken?: string | null;
  lastChatTs?: number;
  lastCommentTs?: number;
}

export function participantCanEdit(
  participant: Pick<SessionParticipant, "role" | "editOverride">,
  mode: CollaborationMode,
): boolean {
  if (participant.role === "host") return true;
  if (participant.editOverride !== undefined) return participant.editOverride;
  return mode === "co-edit";
}

export function participantCanEditLayer(
  participant: Pick<SessionParticipant, "role" | "editOverride">,
  mode: CollaborationMode,
  layerId: string,
  lockedLayerIds: string[] = [],
): boolean {
  if (!participantCanEdit(participant, mode)) return false;
  if (participant.role === "host") return true;
  return !lockedLayerIds.includes(layerId);
}

/**
 * Stable-ish key a host's block and persisted edit override are recorded
 * against.
 *
 * Only the identity and invite forms are durable. The `anon:` fallback keys on
 * a `clientId` the relay mints fresh on every join, so for an anonymous guest
 * both a block and an override are forgotten the moment they reconnect. That is
 * a known limit, not an oversight: without an identity or an invite there is
 * nothing about an anonymous joiner to remember, and any client-supplied handle
 * is trivially reset. Blocking is a moderation convenience, not a security
 * boundary — see the *Moderation* section of `docs/collaboration.md`.
 */
export function getParticipantKey(
  participant: Pick<SessionParticipant, "clientId" | "identity" | "inviteToken">,
): string {
  if (participant.identity?.userId) {
    return `user:${participant.identity.userId}`;
  }
  if (participant.inviteToken) {
    return `invite:${participant.inviteToken}`;
  }
  return `anon:${participant.clientId}`;
}

function isStructurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isStructurallyEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (
      !isStructurallyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    ) {
      return false;
    }
  }
  return true;
}

export function diffLockedLayers(
  storedProject: unknown,
  inboundProject: unknown,
  lockedLayerIds: string[] = [],
): { lockedId: string; layerName: string } | null {
  if (!lockedLayerIds.length || !storedProject || !inboundProject) return null;
  if (typeof storedProject !== "object" || typeof inboundProject !== "object") return null;

  const storedLayers = Array.isArray((storedProject as { layers?: unknown }).layers)
    ? (storedProject as { layers: Record<string, unknown>[] }).layers
    : [];
  const inboundLayers = Array.isArray((inboundProject as { layers?: unknown }).layers)
    ? (inboundProject as { layers: Record<string, unknown>[] }).layers
    : [];

  const storedMap = new Map<string, Record<string, unknown>>();
  for (const layer of storedLayers) {
    if (layer && typeof layer === "object" && typeof layer.id === "string") {
      storedMap.set(layer.id, layer);
    }
  }

  const inboundMap = new Map<string, Record<string, unknown>>();
  for (const layer of inboundLayers) {
    if (layer && typeof layer === "object" && typeof layer.id === "string") {
      inboundMap.set(layer.id, layer);
    }
  }

  for (const lockedId of lockedLayerIds) {
    const stored = storedMap.get(lockedId);
    if (!stored) continue;
    const inbound = inboundMap.get(lockedId);
    const layerName = typeof stored.name === "string" ? stored.name : lockedId;
    if (!inbound) {
      return { lockedId, layerName };
    }
    if (!isStructurallyEqual(stored, inbound)) {
      return { lockedId, layerName };
    }
  }

  return null;
}

export type SnapshotDecision =
  | { ok: true }
  | { ok: false; code: "forbidden" | "too-large" | "layer-locked"; message: string };

/** Shared authorization/size gate used by every relay implementation. */
export function authorizeSnapshot(
  participant: Pick<SessionParticipant, "role" | "editOverride">,
  mode: CollaborationMode,
  byteLength: number,
  maxBytes = MAX_SNAPSHOT_BYTES,
  storedSnapshot?: unknown,
  inboundSnapshot?: unknown,
  lockedLayerIds: string[] = [],
): SnapshotDecision {
  if (!participantCanEdit(participant, mode)) {
    return {
      ok: false,
      code: "forbidden",
      message:
        participant.editOverride === false
          ? "The host has set you to view-only."
          : "This session is view-only.",
    };
  }
  if (byteLength > maxBytes) {
    return {
      ok: false,
      code: "too-large",
      message: "Project is too large to sync live. Share it via URL instead.",
    };
  }
  if (
    participant.role !== "host" &&
    lockedLayerIds.length > 0 &&
    storedSnapshot &&
    inboundSnapshot
  ) {
    const diff = diffLockedLayers(storedSnapshot, inboundSnapshot, lockedLayerIds);
    if (diff) {
      return {
        ok: false,
        code: "layer-locked",
        message: `Layer "${diff.layerName}" is locked by the host and cannot be modified.`,
      };
    }
  }
  return { ok: true };
}

export function authorizeHostAction(
  participant: Pick<SessionParticipant, "role">,
  action: string,
): string | null {
  return participant.role === "host" ? null : `Only the host can change ${action}.`;
}

export function normalizeMode(mode: unknown): CollaborationMode {
  return mode === "view-only" ? "view-only" : "co-edit";
}

export function setParticipantOverride(
  actor: Pick<SessionParticipant, "role">,
  participants: SessionParticipant[],
  clientId: unknown,
  canEdit: unknown,
): boolean {
  if (actor.role !== "host" || typeof clientId !== "string") return false;
  const target = participants.find((p) => p.clientId === clientId);
  if (!target || target.role === "host") return false;
  target.editOverride = canEdit === true;
  return true;
}

export function clearParticipantOverrides(participants: SessionParticipant[]): boolean {
  let changed = false;
  for (const participant of participants) {
    if (participant.editOverride !== undefined) {
      participant.editOverride = undefined;
      changed = true;
    }
  }
  return changed;
}

export function toWireParticipant(participant: SessionParticipant): CollabParticipant {
  return {
    clientId: participant.clientId,
    displayName: participant.displayName,
    color: participant.color,
    role: participant.role,
    editOverride: participant.role === "host" ? null : (participant.editOverride ?? null),
    identity: participant.identity
      ? {
          provider: participant.identity.provider,
          userId: participant.identity.userId,
          username: participant.identity.username,
        }
      : null,
  };
}

export function sanitizeDisplayName(value: unknown): string {
  // Trimmed before the fallback: a whitespace-only string is truthy, so "   "
  // would otherwise pass through as the name in the roster, every participants
  // broadcast, and every chat author field. `validateAuthor` already trims.
  return (typeof value === "string" ? value.trim() : "").slice(0, 60) || "Guest";
}

export function sanitizeColor(value: unknown): string {
  return typeof value === "string" && HEX_COLOR_RE.test(value) ? value : "#888888";
}

export function sanitizeCursor(c: unknown): CollabCursor | null {
  if (c && typeof c === "object") {
    const { lng, lat } = c as Record<string, unknown>;
    if (finite(lng) && finite(lat)) return { lng, lat };
  }
  return null;
}

export function sanitizeView(v: unknown): CollabView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const center = o.center;
  if (!Array.isArray(center) || !finite(center[0]) || !finite(center[1])) return null;
  const view: CollabView = {
    center: [center[0], center[1]],
    zoom: finite(o.zoom) ? o.zoom : 0,
    bearing: finite(o.bearing) ? o.bearing : 0,
    pitch: finite(o.pitch) ? o.pitch : 0,
  };
  const bbox = o.bbox;
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(finite)) {
    view.bbox = [bbox[0], bbox[1], bbox[2], bbox[3]];
  }
  return view;
}

/**
 * Validate one stored chat entry's field types so a corrupt record cannot reach
 * clients, where a bad `coordinate` would crash `coordinate.lat.toFixed`. A
 * read-path guard against tampering or a partial write, deliberately not a full
 * mirror of the write path.
 */
export function isValidChatMessage(m: unknown): m is CollabChatMessage {
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
    typeof o.color === "string" &&
    HEX_COLOR_RE.test(o.color) &&
    typeof o.text === "string" &&
    o.text !== "" &&
    finite(o.ts) &&
    coordOk
  );
}

/** Parse a persisted chat log, dropping entries that fail {@link isValidChatMessage}. */
export function parseStoredChat(raw: unknown): CollabChatMessage[] {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw.filter(isValidChatMessage) : [];
}
