/**
 * Ephemeral live-collaboration session state (issue #307): never saved with the
 * project and never tracked by undo history.
 */
import type {
  CollabInvite,
  CollaborationChatMessage,
  CollaborationParticipant,
  CollaborationPresence,
  CollaborationState,
} from "../types";
import type { SliceCreator } from "./types";

/**
 * A fresh, inactive collaboration slice (no live session). Frozen (like
 * DEFAULT_LEGEND_CONFIG) to guard against accidental in-place mutation; store
 * actions always produce new objects via spread, so the frozen default is only
 * ever read.
 */
export const DEFAULT_COLLABORATION_STATE: CollaborationState = Object.freeze({
  isActive: false,
  connecting: false,
  sessionId: null,
  clientId: null,
  role: null,
  mode: "co-edit",
  selfName: "",
  selfColor: "",
  participants: Object.freeze([] as CollaborationParticipant[]) as CollaborationParticipant[],
  presence: Object.freeze({} as Record<string, CollaborationPresence>) as Record<
    string,
    CollaborationPresence
  >,
  followHost: false,
  chat: Object.freeze([] as CollaborationChatMessage[]) as CollaborationChatMessage[],
  requireIdentity: false,
  identitySupported: false,
  lockedLayerIds: Object.freeze([] as string[]) as string[],
  invites: Object.freeze([] as CollabInvite[]) as CollabInvite[],
  error: null,
});

// Cap the in-store chat log so a long session can't grow it without bound. This
// is intentionally larger than the relay's persisted history (50): the live
// session accumulates messages locally, while the relay only retains the tail
// for late joiners.
const MAX_COLLABORATION_CHAT = 200;

export interface CollaborationSlice {
  // Ephemeral live-collaboration session state (issue #307). Deliberately
  // excluded from the project file (project.ts never reads it) and from undo
  // history (partialize never lists it).
  collaboration: CollaborationState;

  setCollaboration: (patch: Partial<CollaborationState>) => void;
  updateCollaborationPresence: (clientId: string, presence: CollaborationPresence | null) => void;
  /** Append a chat message to the session log (bounded; #754). */
  addCollaborationChat: (message: CollaborationChatMessage) => void;
  resetCollaboration: () => void;
}

export const createCollaborationSlice: SliceCreator<CollaborationSlice> = (set) => ({
  collaboration: DEFAULT_COLLABORATION_STATE,

  setCollaboration: (patch) => set((s) => ({ collaboration: { ...s.collaboration, ...patch } })),
  // Add or remove a single remote participant's presence without rebuilding
  // the whole map on every cursor move. Passing `null` drops the entry (on
  // participant leave).
  updateCollaborationPresence: (clientId, presence) =>
    set((s) => {
      const next = { ...s.collaboration.presence };
      if (presence === null) {
        delete next[clientId];
      } else {
        next[clientId] = presence;
      }
      return { collaboration: { ...s.collaboration, presence: next } };
    }),
  addCollaborationChat: (message) =>
    set((s) => {
      // Default to [] in case an older relay left the slice undefined.
      const current = s.collaboration.chat ?? [];
      // Ignore a duplicate id: the server broadcasts to the sender too, and a
      // reconnect can replay recent history, so de-dupe defensively.
      if (current.some((m) => m.id === message.id)) return s;
      const chat = [...current, message].slice(-MAX_COLLABORATION_CHAT);
      return { collaboration: { ...s.collaboration, chat } };
    }),
  resetCollaboration: () =>
    // Also close the Collaborate dialog: an unexpected disconnect resets the
    // slice without a user-initiated leave(), and leaving the dialog open
    // would drop the user onto the start/join form with no context.
    set((s) => ({
      collaboration: DEFAULT_COLLABORATION_STATE,
      ui: { ...s.ui, collaborateDialogOpen: false },
    })),
});
