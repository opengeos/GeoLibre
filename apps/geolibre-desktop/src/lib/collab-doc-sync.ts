// Client half of op-level collaboration (#3530).
//
// `CollabDocSync` keeps this participant's copy of the session's Yjs document
// and moves changes between it, the relay and the app store:
//
//   store edit  -> write(project)  -> doc diff (origin LOCAL) -> doc-update frames
//   relay frame -> doc update      -> read()  -> applyProject(store)
//   undo/redo   -> Y.UndoManager   -> doc diff -> both of the above
//
// The undo manager records only LOCAL transactions, so undo reverts this
// participant's own edits and never a collaborator's. It is framework-free and
// takes the Yjs model as a constructor argument, so the hook can load Yjs
// lazily (the feature is dark unless a relay is configured) and tests can drive
// two instances through a real relay document.

import type * as Crdt from "@geolibre/collab-core/crdt";
import type { GeoLibreProject } from "@geolibre/core";
import type { ClientMessage, ServerMessage } from "./collab-protocol";

export type CrdtModule = typeof Crdt;

/** How long a remote apply waits before checking again for a pending local edit. */
const LOCAL_PENDING_RETRY_MS = 50;

/** Origin of this participant's own edits; the only one undo records. */
export const LOCAL_ORIGIN = "local";
/** Origin of updates that arrived from the relay. */
const REMOTE_ORIGIN = "remote";
/** Origin of the host's first write into an empty session document. */
const SEED_ORIGIN = "seed";

/**
 * Project keys each participant keeps for themself: their camera, their
 * plugin activation and their selection. Comments are written by the relay
 * from `comment-mutation` frames, so clients leave them alone too.
 */
export const LOCAL_ONLY_KEYS: ReadonlySet<string> = new Set([
  "mapView",
  "plugins",
  "selectedLayerId",
  "comments",
]);

/** What the sync needs from its surroundings. */
export interface DocSyncHost {
  /** Send a frame to the relay; false when the socket is not open. */
  send: (message: ClientMessage) => boolean;
  /**
   * Put the document's project into the store. `initial` is true for the
   * first apply after joining, when the store holds the participant's own
   * project rather than the session's.
   */
  applyProject: (project: GeoLibreProject, initial: boolean) => void;
  /** The participant's current project, to seed an empty session document. */
  seedProject: () => Promise<GeoLibreProject | null>;
  canEdit: () => boolean;
  isHost: () => boolean;
  /**
   * Whether a local edit has not reached the document yet. A remote apply
   * waits for it: replacing the store first would drop the edit.
   */
  isLocalPending?: () => boolean;
  /** Undo/redo availability changed. */
  onHistoryChange?: () => void;
  /** Delay before applying a burst of remote updates; tests pass 0. */
  applyDelayMs?: number;
}

export class CollabDocSync {
  private project: Crdt.ProjectDoc;
  private undoManager: Crdt.Y.UndoManager;
  private readonly assembler: Crdt.UpdateAssembler;
  private synced = false;
  private initialApplied = false;
  private paused = false;
  private destroyed = false;
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private chunkCounter = 0;
  private detach: () => void = () => {};

  constructor(
    private readonly crdt: CrdtModule,
    private readonly host: DocSyncHost,
  ) {
    this.assembler = new crdt.UpdateAssembler(Number.MAX_SAFE_INTEGER);
    this.project = new crdt.ProjectDoc(new crdt.Y.Doc());
    this.undoManager = this.attach(this.project);
  }

  /** Whether the first sync with the relay has finished. */
  get isSynced(): boolean {
    return this.synced;
  }

  /** The document's project, as the store should hold it. */
  read(): GeoLibreProject {
    return this.project.read() as unknown as GeoLibreProject;
  }

  /**
   * Start (or restart, after a reconnect) the sync handshake. The document is
   * kept across reconnects, so edits made while offline reach the session.
   */
  start(): void {
    this.assembler.forget(REMOTE_ORIGIN);
    const vector = this.crdt.encodeBase64(this.crdt.Y.encodeStateVector(this.project.doc));
    this.host.send({ type: "doc-sync", stateVector: vector });
  }

  /**
   * Handle a relay frame. Returns true when the frame belonged to the
   * document protocol (and was consumed here).
   */
  handle(message: ServerMessage): boolean {
    if (this.destroyed) return false;
    if (message.type === "doc-update") {
      // Frames from different origins never interleave mid-update (the relay
      // sends each update's chunks back to back), so one stream suffices.
      const result = this.assembler.push(REMOTE_ORIGIN, message);
      if (result.status === "complete") {
        try {
          this.crdt.Y.applyUpdate(this.project.doc, result.update, REMOTE_ORIGIN);
        } catch {
          this.resync();
          return true;
        }
        if (this.synced) this.scheduleApply();
      } else if (result.status === "error") {
        this.resync();
      }
      return true;
    }
    if (message.type === "doc-synced") {
      void this.finishSync(message.stateVector);
      return true;
    }
    if (message.type === "error") {
      if (message.code === "resync") {
        this.resync();
        return true;
      }
      if (message.code === "forbidden" && this.synced) {
        // Our document holds an update the relay refused, which would block
        // every later one; start over from the relay's copy.
        this.reset();
        return false;
      }
      if (message.code === "too-large") this.paused = true;
    }
    return false;
  }

  /**
   * Record a local edit. With `base`, the project the store last took from
   * the document, only what changed since `base` is written, so a peer's edit
   * that arrived in the meantime is kept; without it, `project` is written as
   * the differences from the document.
   */
  pushLocal(project: GeoLibreProject, base?: GeoLibreProject | null): void {
    if (!this.synced || this.paused || this.destroyed || !this.host.canEdit()) return;
    const next = project as unknown as Crdt.ProjectRecord;
    const options = { ignore: LOCAL_ONLY_KEYS };
    if (base) {
      this.project.writeChanges(next, base as unknown as Crdt.ProjectRecord, LOCAL_ORIGIN, options);
    } else {
      this.project.write(next, LOCAL_ORIGIN, options);
    }
  }

  canUndo(): boolean {
    return this.host.canEdit() && this.undoManager.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.host.canEdit() && this.undoManager.redoStack.length > 0;
  }

  undo(): void {
    if (this.canUndo()) this.undoManager.undo();
  }

  redo(): void {
    if (this.canRedo()) this.undoManager.redo();
  }

  /** Stop syncing and release the document. */
  destroy(): void {
    this.destroyed = true;
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.detach();
    this.undoManager.destroy();
    this.project.destroy();
    this.project.doc.destroy();
  }

  private attach(project: Crdt.ProjectDoc): Crdt.Y.UndoManager {
    const undoManager = this.crdt.createLocalUndoManager(project, LOCAL_ORIGIN);
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return;
      // Local edits, the seed and undo/redo steps all go to the relay.
      if (!this.paused) this.sendUpdate(update);
      // An undo/redo step changed the document, not the store: apply it.
      if (origin === undoManager) this.scheduleApply(0);
    };
    project.doc.on("update", onUpdate);
    const notify = () => this.host.onHistoryChange?.();
    undoManager.on("stack-item-added", notify);
    undoManager.on("stack-item-popped", notify);
    undoManager.on("stack-cleared", notify);
    this.detach = () => {
      project.doc.off("update", onUpdate);
      undoManager.off("stack-item-added", notify);
      undoManager.off("stack-item-popped", notify);
      undoManager.off("stack-cleared", notify);
    };
    return undoManager;
  }

  private sendUpdate(update: Uint8Array): void {
    for (const frame of this.crdt.splitUpdate(update, () => `u${++this.chunkCounter}`)) {
      this.host.send({ type: "doc-update", ...frame });
    }
  }

  private async finishSync(relayVector: string): Promise<void> {
    const vector = this.crdt.decodeBase64(relayVector);
    const firstSync = !this.synced;
    this.synced = true;
    if (vector && this.host.canEdit() && !this.paused) {
      // Whatever the relay lacks: edits made offline, or nothing.
      const missing = this.crdt.Y.encodeStateAsUpdate(this.project.doc, vector);
      if (missing.length > 2) this.sendUpdate(missing);
    }
    if (this.project.isEmpty()) {
      if (firstSync && this.host.isHost() && this.host.canEdit()) {
        const seed = await this.host.seedProject();
        if (this.destroyed || !seed || !this.project.isEmpty()) return;
        // The host's own project becomes the session's, comments included
        // (later writes leave comments to the relay).
        const ignore = new Set(LOCAL_ONLY_KEYS);
        ignore.delete("comments");
        this.project.write(seed as unknown as Crdt.ProjectRecord, SEED_ORIGIN, { ignore });
        this.initialApplied = true;
      }
      this.host.onHistoryChange?.();
      return;
    }
    this.applyNow();
    this.host.onHistoryChange?.();
  }

  private scheduleApply(delay = this.host.applyDelayMs ?? 30): void {
    if (this.applyTimer) return;
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null;
      if (!this.destroyed) this.applyNow();
    }, delay);
  }

  private applyNow(): void {
    if (this.project.isEmpty()) return;
    const initial = !this.initialApplied;
    if (!initial && this.host.isLocalPending?.()) {
      this.scheduleApply(LOCAL_PENDING_RETRY_MS);
      return;
    }
    this.initialApplied = true;
    this.host.applyProject(this.read(), initial);
  }

  private resync(): void {
    this.assembler.forget(REMOTE_ORIGIN);
    this.start();
  }

  /** Throw the document away and sync a fresh one from the relay. */
  private reset(): void {
    this.detach();
    this.undoManager.destroy();
    this.project.destroy();
    this.project.doc.destroy();
    this.project = new this.crdt.ProjectDoc(new this.crdt.Y.Doc());
    this.undoManager = this.attach(this.project);
    this.synced = false;
    this.host.onHistoryChange?.();
    this.start();
  }
}
