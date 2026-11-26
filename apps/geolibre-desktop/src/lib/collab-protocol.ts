// Wire protocol for the live-collaboration relay (issue #307).
//
// This is the frontend copy. The worker keeps a parallel copy in
// `workers/collab/src/protocol.ts` with the `project` field typed as `unknown`
// (the relay never inspects a project). Here `project` is the concrete
// `GeoLibreProject`. Keep the two `type` discriminants and field names in sync.

import type {
  CollabInvite,
  CollaborationChatMessage,
  CollaborationMode,
  CollaborationParticipant,
  CollaborationRole,
  CommentReply,
  GeoLibreProject,
  MapViewState,
  ProjectComment,
} from "@geolibre/core";

export type { CollaborationMode, CollaborationRole, CollabInvite };

/** Capability a client and relay exchange to sync op by op (#3530). */
export const CRDT_FEATURE = "crdt-v1";

export interface CollabCursor {
  lng: number;
  lat: number;
}

/**
 * Effective edit permission for a participant given the current session mode
 * (#754). The host always edits; otherwise a host-set per-participant override
 * wins, falling back to the session default.
 *
 * @param participant - The participant to evaluate.
 * @param mode - The current session mode.
 * @returns True when this participant may edit the project.
 */
export function participantCanEdit(
  participant: CollaborationParticipant,
  mode: CollaborationMode,
): boolean {
  if (participant.role === "host") return true;
  return participant.editOverride ?? mode === "co-edit";
}

/**
 * Effective layer edit permission. Host can edit any layer; guests with general
 * edit permission cannot edit layers that are explicitly locked.
 */
export function participantCanEditLayer(
  participant: CollaborationParticipant,
  mode: CollaborationMode,
  layerId: string,
  lockedLayerIds: string[] = [],
): boolean {
  if (!participantCanEdit(participant, mode)) return false;
  if (participant.role === "host") return true;
  return !lockedLayerIds.includes(layerId);
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
   * `verifyIdentityToken` in `@geolibre/collab-core`; a relay with no signing
   * secret configured ignores this field entirely.
   */
  identityToken?: string;
  /** Protocol capabilities this client speaks (`"crdt-v1"`: op-level sync, #3530). */
  features?: string[];
}

/** One chunk of a Yjs update that spans several frames. */
export interface DocUpdateChunk {
  id: string;
  index: number;
  count: number;
}

/** Ask for the document updates this client lacks (base64 state vector). */
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
  project: GeoLibreProject;
  rev: number;
}

export interface ClientPresenceMessage {
  type: "presence";
  cursor?: CollabCursor | null;
  view?: MapViewState | null;
}

export interface SetModeMessage {
  type: "set-mode";
  mode: CollaborationMode;
}

/** Host-only: pin one participant to can-edit / view-only (#754). */
export interface SetParticipantModeMessage {
  type: "set-participant-mode";
  clientId: string;
  canEdit: boolean;
}

/** Send a chat message to the session (#754). */
export interface ChatSendMessage {
  type: "chat";
  text: string;
  coordinate?: CollabCursor | null;
}

export type CommentMutationAction =
  | { type: "add"; comment: ProjectComment }
  | { type: "reply"; commentId: string; reply: CommentReply }
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
  participants: CollaborationParticipant[];
  snapshot: GeoLibreProject | null;
  /** Current presence of existing participants (keyed by clientId) so a late
   *  joiner sees their cursors/viewports without waiting for the next move. */
  presence: Record<string, PresenceEntry>;
  /** Recent chat history so a late joiner sees the conversation so far (#754). */
  chat: CollaborationChatMessage[];
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
  /** Capabilities the relay speaks; `"crdt-v1"` means `snapshot` is null and the project syncs op by op. */
  features?: string[];
}

export interface PresenceEntry {
  cursor?: CollabCursor | null;
  view?: MapViewState | null;
}

export interface ServerSnapshotMessage {
  type: "snapshot";
  project: GeoLibreProject;
  origin: string;
  rev: number;
}

/** A document update relayed from `origin` (or the relay itself). */
export interface ServerDocUpdateMessage {
  type: "doc-update";
  update: string;
  chunk?: DocUpdateChunk;
  origin: string;
  rev: number;
}

/** Ends the reply to `doc-sync`; carries the relay's own state vector. */
export interface DocSyncedMessage {
  type: "doc-synced";
  stateVector: string;
  rev: number;
}

export interface ServerPresenceMessage {
  type: "presence";
  clientId: string;
  cursor?: CollabCursor | null;
  view?: MapViewState | null;
}

export interface ParticipantsMessage {
  type: "participants";
  participants: CollaborationParticipant[];
}

export interface ModeMessage {
  type: "mode";
  mode: CollaborationMode;
}

/** Fan-out of a chat message to every participant (including the sender). */
export interface ChatBroadcastMessage {
  type: "chat";
  message: CollaborationChatMessage;
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
