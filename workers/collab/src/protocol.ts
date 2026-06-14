// Wire protocol for the live-collaboration relay.
//
// This is the worker-side copy. The frontend keeps a parallel copy in
// `apps/geolibre-desktop/src/lib/collab-protocol.ts` with the `project` field
// typed as the concrete `GeoLibreProject`. The relay never inspects a project's
// contents — it only stores and forwards the opaque JSON — so here `project` is
// `unknown`. Keep the two `type` discriminants and field names in sync.

export type CollaborationRole = "host" | "guest";
export type CollaborationMode = "view-only" | "co-edit";

export interface CollabParticipant {
  clientId: string;
  displayName: string;
  color: string;
  role: CollaborationRole;
}

export interface CollabCursor {
  lng: number;
  lat: number;
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
  participants: CollabParticipant[];
  snapshot: unknown | null;
  rev: number;
}

export interface ServerSnapshotMessage {
  type: "snapshot";
  project: unknown;
  origin: string;
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
