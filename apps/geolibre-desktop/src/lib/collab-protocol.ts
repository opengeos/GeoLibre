// Wire protocol for the live-collaboration relay (issue #307).
//
// This is the frontend copy. The worker keeps a parallel copy in
// `workers/collab/src/protocol.ts` with the `project` field typed as `unknown`
// (the relay never inspects a project). Here `project` is the concrete
// `GeoLibreProject`. Keep the two `type` discriminants and field names in sync.

import type {
  CollaborationChatMessage,
  CollaborationMode,
  CollaborationParticipant,
  CollaborationRole,
  GeoLibreProject,
  MapViewState,
} from "@geolibre/core";

export type { CollaborationMode, CollaborationRole };

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

// Client -> server -----------------------------------------------------------

export interface JoinMessage {
  type: "join";
  clientId: string;
  displayName: string;
  color: string;
  /** Presented by the session creator to claim the host role. */
  hostToken?: string;
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

export type ClientMessage =
  | JoinMessage
  | ClientSnapshotMessage
  | ClientPresenceMessage
  | SetModeMessage
  | SetParticipantModeMessage
  | ChatSendMessage;

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

export interface ErrorMessage {
  type: "error";
  code: "forbidden" | "too-large" | "bad-message" | "not-found";
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | ServerSnapshotMessage
  | ServerPresenceMessage
  | ParticipantsMessage
  | ModeMessage
  | ChatBroadcastMessage
  | ErrorMessage;
