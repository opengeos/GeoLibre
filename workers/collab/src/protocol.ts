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
  /**
   * Host-set per-participant edit override (#754, Part 3). `null` means "follow
   * the session mode"; `true`/`false` pins this participant to can-edit /
   * view-only regardless of the session default. Always `null` for the host
   * (the host can always edit).
   */
  editOverride: boolean | null;
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
  participants: CollabParticipant[];
  snapshot: unknown | null;
  /** Current presence of existing participants (keyed by clientId) so a late
   *  joiner sees their cursors/viewports without waiting for the next move. */
  presence: Record<string, PresenceEntry>;
  /** Recent chat history so a late joiner sees the conversation so far (#754). */
  chat: CollabChatMessage[];
  rev: number;
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
