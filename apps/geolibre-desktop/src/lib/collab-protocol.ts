// Wire protocol for the live-collaboration relay (issue #307).
//
// This is the frontend copy. The worker keeps a parallel copy in
// `workers/collab/src/protocol.ts` with the `project` field typed as `unknown`
// (the relay never inspects a project). Here `project` is the concrete
// `GeoLibreProject`. Keep the two `type` discriminants and field names in sync.

import type {
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

export type ClientMessage =
  | JoinMessage
  | ClientSnapshotMessage
  | ClientPresenceMessage
  | SetModeMessage;

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
  | ErrorMessage;
