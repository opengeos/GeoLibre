// Wire protocol for the live-collaboration relay.
//
// This is the single relay-side definition: both the Cloudflare Worker
// (`workers/collab/src/protocol.ts` re-exports it) and the Node relay build on
// it, as does the conformance suite. The frontend keeps a parallel copy in
// `apps/geolibre-desktop/src/lib/collab-protocol.ts` with the `project` field
// typed as the concrete `GeoLibreProject`. The relay never inspects a project's
// contents — it only stores and forwards the opaque JSON — so here `project` is
// `unknown`. Keep the two `type` discriminants and field names in sync.

/** Capability string a client and relay exchange to opt into op-level sync. */
export const CRDT_FEATURE = "crdt-v1";

export type CollaborationRole = "host" | "guest";
export type CollaborationMode = "view-only" | "co-edit";

export interface ParticipantIdentity {
  provider: string;
  userId: string;
  username: string;
}

export interface CollabInvite {
  token: string;
  role: CollaborationMode;
  createdAt: number;
  maxUses?: number;
  useCount: number;
  revoked: boolean;
}

export interface CollabParticipant {
  clientId: string;
  displayName: string;
  color: string;
  role: CollaborationRole;
  /**
   * Host-set per-participant edit override (#754, Part 3). `null` means "follow
   * the session mode"; `true`/`false` pins this participant to can-edit /
   * view-only regardless of the session default. Always `null` for the host
   * (the host can always edit).
   */
  editOverride: boolean | null;
  /** Optional account identity when signed-in identity binding is enabled. */
  identity?: ParticipantIdentity | null;
}

export interface CollabCursor {
  lng: number;
  lat: number;
}

/** One in-session chat message (#754, Part 4). Ephemeral session state. */
export interface CollabChatMessage {
  /** Server-assigned id (dedupes optimistic local rendering / React keys). */
  id: string;
  /** clientId of the author. */
  clientId: string;
  displayName: string;
  color: string;
  text: string;
  /** Optional map coordinate the author attached; clickable in peers' UIs. */
  coordinate?: CollabCursor | null;
  /** Server-assigned epoch-ms timestamp. */
  ts: number;
}

export interface CollabView {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  bbox?: [number, number, number, number];
}

// Client -> server -----------------------------------------------------------

export interface JoinMessage {
  type: "join";
  clientId: string;
  displayName: string;
  color: string;
  /** Presented by the session creator to claim the host role. */
  hostToken?: string;
  /** Optional invite token carrying a baked-in role. */
  inviteToken?: string;
  /**
   * Optional HMAC-signed identity credential minted by the relay's issuer. See
   * `verifyIdentityToken` in `identity.ts` for the format; a relay with no
   * signing secret configured ignores this field entirely.
   */
  identityToken?: string;
  /**
   * Protocol capabilities the client speaks, e.g. `"crdt-v1"` for op-level
   * document sync (#3530). A client that omits it is on the whole-snapshot
   * protocol and keeps receiving `snapshot` frames.
   */
  features?: string[];
}

/** Base64 Yjs update, possibly one chunk of a larger update. */
export interface DocUpdateChunk {
  id: string;
  index: number;
  count: number;
}

/**
 * Ask the relay for the document updates this client lacks. `stateVector` is
 * the base64 Yjs state vector of the client's document ("" for an empty one).
 */
export interface ClientDocSyncMessage {
  type: "doc-sync";
  stateVector: string;
}

/** One Yjs update (or one chunk of it) from a co-editor. */
export interface ClientDocUpdateMessage {
  type: "doc-update";
  update: string;
  chunk?: DocUpdateChunk;
}

export interface ClientSnapshotMessage {
  type: "snapshot";
  project: unknown;
  rev: number;
}

export interface ClientPresenceMessage {
  type: "presence";
  cursor?: CollabCursor | null;
  view?: CollabView | null;
}

export interface SetModeMessage {
  type: "set-mode";
  mode: CollaborationMode;
}

/** Host-only: pin one participant to can-edit / view-only (#754, Part 3). */
export interface SetParticipantModeMessage {
  type: "set-participant-mode";
  clientId: string;
  canEdit: boolean;
}

/** Send a chat message to the session (#754, Part 4). */
export interface ChatSendMessage {
  type: "chat";
  text: string;
  coordinate?: CollabCursor | null;
}

export type CommentMutationAction =
  | { type: "add"; comment: unknown }
  | { type: "reply"; commentId: string; reply: unknown }
  | { type: "toggle-resolve"; commentId: string; resolved?: boolean }
  | { type: "delete"; commentId: string };

export interface CommentMutationMessage {
  type: "comment-mutation";
  action: CommentMutationAction;
}

export interface MintInviteMessage {
  type: "mint-invite";
  role: CollaborationMode;
  maxUses?: number;
}

export interface RevokeInviteMessage {
  type: "revoke-invite";
  token: string;
}

export interface SetSessionConfigMessage {
  type: "set-session-config";
  requireIdentity?: boolean;
}

export interface KickParticipantMessage {
  type: "kick-participant";
  clientId: string;
  reason?: string;
}

export interface BlockParticipantMessage {
  type: "block-participant";
  clientId: string;
  reason?: string;
}

export interface SetLayerLocksMessage {
  type: "set-layer-locks";
  lockedLayerIds: string[];
}

export type ClientMessage =
  | JoinMessage
  | ClientSnapshotMessage
  | ClientPresenceMessage
  | SetModeMessage
  | SetParticipantModeMessage
  | ChatSendMessage
  | CommentMutationMessage
  | MintInviteMessage
  | RevokeInviteMessage
  | SetSessionConfigMessage
  | KickParticipantMessage
  | BlockParticipantMessage
  | SetLayerLocksMessage
  | ClientDocSyncMessage
  | ClientDocUpdateMessage;

// Server -> client -----------------------------------------------------------

export interface WelcomeMessage {
  type: "welcome";
  clientId: string;
  role: CollaborationRole;
  mode: CollaborationMode;
  participants: CollabParticipant[];
  snapshot: unknown | null;
  /** Current presence of existing participants (keyed by clientId) so a late
   *  joiner sees their cursors/viewports without waiting for the next move. */
  presence: Record<string, PresenceEntry>;
  /** Recent chat history so a late joiner sees the conversation so far (#754). */
  chat: CollabChatMessage[];
  rev: number;
  requireIdentity?: boolean;
  /**
   * Whether this relay has an identity issuer configured. False means every
   * joiner is anonymous and `requireIdentity` cannot be turned on, so the host
   * UI hides the toggle rather than offering a gate nobody could pass.
   */
  identitySupported?: boolean;
  lockedLayerIds?: string[];
  invites?: CollabInvite[];
  /**
   * Capabilities the relay speaks. When it lists `"crdt-v1"` and the client
   * asked for it, `snapshot` is null and the project arrives over `doc-sync`.
   */
  features?: string[];
}

export interface PresenceEntry {
  cursor: CollabCursor | null;
  view: CollabView | null;
}

export interface ServerSnapshotMessage {
  type: "snapshot";
  project: unknown;
  origin: string;
  rev: number;
}

/** A document update for this client, relayed from `origin` (or the relay). */
export interface ServerDocUpdateMessage {
  type: "doc-update";
  update: string;
  chunk?: DocUpdateChunk;
  origin: string;
  rev: number;
}

/**
 * Ends the reply to `doc-sync`: every update the client lacked has been sent.
 * `stateVector` is the relay's, so the client can send what the relay lacks.
 */
export interface DocSyncedMessage {
  type: "doc-synced";
  stateVector: string;
  rev: number;
}

export interface ServerPresenceMessage {
  type: "presence";
  clientId: string;
  cursor?: CollabCursor | null;
  view?: CollabView | null;
}

export interface ParticipantsMessage {
  type: "participants";
  participants: CollabParticipant[];
}

export interface ModeMessage {
  type: "mode";
  mode: CollaborationMode;
}

/** Fan-out of a chat message to every participant (including the sender, so the
 *  server's ordering is authoritative). */
export interface ChatBroadcastMessage {
  type: "chat";
  message: CollabChatMessage;
}

export interface InviteCreatedMessage {
  type: "invite-created";
  invite: CollabInvite;
}

export interface InviteRevokedMessage {
  type: "invite-revoked";
  token: string;
}

export interface SessionConfigMessage {
  type: "session-config";
  requireIdentity: boolean;
}

export interface LayerLocksMessage {
  type: "layer-locks";
  lockedLayerIds: string[];
}

export interface KickedMessage {
  type: "kicked";
  reason?: string;
}

export interface ErrorMessage {
  type: "error";
  code:
    | "forbidden"
    | "too-large"
    | "bad-message"
    | "not-found"
    | "identity-required"
    | "identity-unavailable"
    | "layer-locked"
    | "resync";
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | ServerSnapshotMessage
  | ServerPresenceMessage
  | ParticipantsMessage
  | ModeMessage
  | ChatBroadcastMessage
  | CommentMutationMessage
  | InviteCreatedMessage
  | InviteRevokedMessage
  | SessionConfigMessage
  | LayerLocksMessage
  | KickedMessage
  | ErrorMessage
  | ServerDocUpdateMessage
  | DocSyncedMessage;

// Session Log ----------------------------------------------------------------

export type SessionLogEntry =
  | { type: "join"; ts: number; clientId: string; identity?: ParticipantIdentity | null }
  | { type: "leave"; ts: number; clientId: string }
  | { type: "set-mode"; ts: number; mode: CollaborationMode }
  | { type: "set-participant-mode"; ts: number; clientId: string; canEdit: boolean }
  | { type: "snapshot"; ts: number; rev: number; origin: string };
