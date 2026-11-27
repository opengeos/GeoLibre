// Relay-side half of the op-level collaboration protocol (#3530).
//
// Each relay keeps one Yjs document per session, the authoritative copy every
// client syncs against. This module owns that document: loading it from
// storage (and migrating a session that only has a whole-project snapshot),
// applying client updates under the session's permission and layer-lock rules,
// persisting every accepted update to an append-only log that is compacted into
// a fresh base state as it grows, and answering a client's state vector with
// exactly the updates it lacks. Storage and sockets stay with the transports
// (Durable Object SQLite, Node SQLite); both drive this one implementation.

import {
  ProjectDoc,
  UpdateAssembler,
  Y,
  decodeBase64,
  encodeBase64,
  splitUpdate,
  type ProjectRecord,
  type UpdateFrame,
} from "./crdt";
import type { ServerDocUpdateMessage } from "./protocol";

/**
 * Default ceiling on a session document's persisted size, in bytes. It
 * replaces the 10 MB whole-snapshot cap for clients that sync op by op. A
 * Durable Object has 128 MB of memory and a live Yjs document takes a few
 * times its encoded size, so the shared default stays well inside that;
 * a self-hosted Node relay can raise it with `COLLAB_MAX_DOC_BYTES`.
 */
export const MAX_DOC_BYTES = 32 * 1024 * 1024;

/**
 * Compact the update log into a new base once it holds this many bytes (or
 * half the base, if larger)...
 */
export const DOC_COMPACT_LOG_BYTES = 4 * 1024 * 1024;
/** ...or this many entries, once the log is at least a quarter of the base. */
export const DOC_COMPACT_LOG_ENTRIES = 256;

/**
 * Largest single stored value. A Durable Object caps a SQLite value at 2 MB,
 * so a base state or a large update is split across rows of this size.
 */
export const DOC_STORAGE_CHUNK_BYTES = 1024 * 1024;

/** Top-level fields only the relay writes; client updates to them are undone. */
export const PROTECTED_FIELDS: readonly string[] = ["comments"];

/** Origin label on updates the relay itself produces (reverts, comments). */
export const RELAY_DOC_ORIGIN = "relay";

/**
 * Synchronous persistence for one session's document. Both relays' SQLite APIs
 * are synchronous, which keeps an accepted update and its log entry in step.
 */
export interface DocStorage {
  /** The stored base state and the updates logged after it, oldest first. */
  load(): { base: Uint8Array | null; log: Uint8Array[] };
  /** Append one accepted update to the log. */
  append(update: Uint8Array): void;
  /** Store `base` as the new base state and empty the log. */
  replace(base: Uint8Array): void;
}

/** Split bytes into pieces of at most `size` for row-sized storage. */
export function chunkBytes(bytes: Uint8Array, size = DOC_STORAGE_CHUNK_BYTES): Uint8Array[] {
  if (bytes.length === 0) return [bytes];
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    parts.push(bytes.subarray(offset, offset + size));
  }
  return parts;
}

/** Join row-sized pieces back into one buffer. */
export function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** What a client's permissions allow for one update. */
export interface DocUpdateContext {
  canEdit: boolean;
  isHost: boolean;
  lockedLayerIds: readonly string[];
}

export type DocReceiveResult =
  | { status: "pending" }
  | { status: "applied" }
  | { status: "reverted"; layerName: string }
  | {
      status: "error";
      code: "forbidden" | "too-large" | "resync";
      message: string;
    };

export interface RelayDocOptions {
  storage: DocStorage;
  /** Ceiling on the persisted document size; see {@link MAX_DOC_BYTES}. */
  maxDocBytes?: number;
  /**
   * The session's whole-project snapshot, read only when no document has been
   * stored yet, so a session started before op-level sync carries on with its
   * project intact.
   */
  legacySnapshot?: () => unknown;
  /** Called after a legacy snapshot was migrated, so it can be deleted. */
  onMigrated?: () => void;
  /** Called for every update that changed the document, after it is stored. */
  onUpdate?: (update: Uint8Array, origin: string) => void;
}

interface ClientOrigin {
  clientId: string;
}

function originLabel(origin: unknown): string {
  if (typeof origin === "string") return origin;
  if (origin && typeof origin === "object" && "clientId" in origin) {
    return String((origin as ClientOrigin).clientId);
  }
  return RELAY_DOC_ORIGIN;
}

/**
 * Which layer ids a transaction changed: keys added to or removed from the
 * `layers` root, and the layer under which any nested change happened.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs types are invariant in their event type
type AnyType = Y.AbstractType<any>;

function touchedLayers(transaction: Y.Transaction, layers: AnyType): Set<string> {
  const touched = new Set<string>();
  transaction.changed.forEach((keys, type) => {
    if (type === layers) {
      for (const key of keys) if (key) touched.add(key);
      return;
    }
    let current: AnyType = type;
    while (current._item) {
      const parent = current._item.parent as AnyType;
      if (parent === layers) {
        if (current._item.parentSub) touched.add(current._item.parentSub);
        return;
      }
      current = parent;
    }
  });
  return touched;
}

/** One session's authoritative document. */
export class RelayDoc {
  readonly project: ProjectDoc;
  private readonly storage: DocStorage;
  private readonly maxDocBytes: number;
  private readonly onUpdate?: (update: Uint8Array, origin: string) => void;
  private readonly assembler: UpdateAssembler;
  private baseBytes = 0;
  private logBytes = 0;
  private logEntries = 0;

  constructor(options: RelayDocOptions) {
    this.storage = options.storage;
    this.maxDocBytes = options.maxDocBytes ?? MAX_DOC_BYTES;
    this.onUpdate = options.onUpdate;
    this.assembler = new UpdateAssembler(this.maxDocBytes);
    const doc = new Y.Doc();
    this.project = new ProjectDoc(doc);

    const { base, log } = this.storage.load();
    // A corrupt row must not lock every joiner out of the session: skip what
    // cannot be read and keep the rest (the next compaction rewrites it).
    if (base) {
      try {
        Y.applyUpdate(doc, base);
      } catch (error) {
        console.warn("[collab] skipped an unreadable stored base state", error);
      }
      this.baseBytes = base.length;
    }
    for (const update of log) {
      try {
        Y.applyUpdate(doc, update);
      } catch (error) {
        console.warn("[collab] skipped an unreadable stored update", error);
      }
      this.logBytes += update.length;
      this.logEntries += 1;
    }
    if (!base && log.length === 0) {
      const legacy = options.legacySnapshot?.();
      if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
        this.project.write(legacy as ProjectRecord, RELAY_DOC_ORIGIN);
        this.compact();
        options.onMigrated?.();
      }
    }

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.storage.append(update);
      this.logBytes += update.length;
      this.logEntries += 1;
      this.onUpdate?.(update, originLabel(origin));
    });
  }

  /** Approximate persisted size: the base plus the log since. */
  get byteSize(): number {
    return this.baseBytes + this.logBytes;
  }

  /** The server state vector, base64, for a `doc-synced` reply. */
  stateVector(): string {
    return encodeBase64(Y.encodeStateVector(this.project.doc));
  }

  /**
   * The updates a client with state vector `vector` (base64) lacks, framed
   * for the wire. An empty or missing vector means "everything". Returns null
   * when the vector is malformed.
   */
  framesFor(vector: unknown, makeId: () => string): UpdateFrame[] | null {
    let decoded: Uint8Array | undefined;
    if (vector !== undefined && vector !== null && vector !== "") {
      const bytes = decodeBase64(vector);
      if (!bytes) return null;
      decoded = bytes;
    }
    let update: Uint8Array;
    try {
      update = Y.encodeStateAsUpdate(this.project.doc, decoded);
    } catch {
      return null;
    }
    return splitUpdate(update, makeId);
  }

  /**
   * Take one `doc-update` frame from `clientId`. Chunks are buffered until the
   * whole update has arrived; the update is then applied when the client may
   * edit, and reverted (for everyone, the sender included) when it touches a
   * layer the host locked.
   */
  receive(
    clientId: string,
    frame: { update?: unknown; chunk?: unknown },
    context: DocUpdateContext,
  ): DocReceiveResult {
    if (!context.canEdit) {
      this.assembler.forget(clientId);
      return {
        status: "error",
        code: "forbidden",
        message: "This session is view-only.",
      };
    }
    const assembled = this.assembler.push(clientId, frame);
    if (assembled.status === "pending") return assembled;
    if (assembled.status === "error") {
      return assembled.reason === "too-large"
        ? { status: "error", code: "too-large", message: tooLargeMessage() }
        : { status: "error", code: "resync", message: "Update could not be read; resyncing." };
    }
    const update = assembled.update;
    if (this.byteSize + update.length > this.maxDocBytes) {
      return { status: "error", code: "too-large", message: tooLargeMessage() };
    }

    const origin: ClientOrigin = { clientId };
    const doc = this.project.doc;
    const guard = !context.isHost && context.lockedLayerIds.length > 0;
    let undo: Y.UndoManager | null = null;
    let touched = new Set<string>();
    const watch = (transaction: Y.Transaction) => {
      if (transaction.origin === origin) touched = touchedLayers(transaction, this.project.layers);
    };
    if (guard) {
      undo = new Y.UndoManager(
        [this.project.fields, this.project.layers, this.project.layerOrder],
        { trackedOrigins: new Set([origin]), captureTimeout: 0 },
      );
      doc.on("afterTransaction", watch);
    }
    // Fields only the relay writes (the comment list, which comment-mutation
    // validates and rate-limits): a client update may not change them.
    // The host's first write into an empty session (its seed) may carry them.
    const seeding = this.project.isEmpty();
    const protectedBefore = seeding
      ? []
      : PROTECTED_FIELDS.map((key) => [key, this.project.fields.get(key)] as const);
    let unreadable = false;
    try {
      Y.applyUpdate(doc, update, origin);
    } catch {
      // Yjs may have integrated part of the update before decoding failed;
      // the lock check below still reverts whatever reached a locked layer.
      unreadable = true;
    } finally {
      if (guard) doc.off("afterTransaction", watch);
    }
    // Structs whose dependencies never arrived are held by Yjs outside the
    // document (and outside `byteSize`). A client syncs against our state, so
    // this only happens to a broken or hostile sender: drop them and resync.
    const store = doc.store as { pendingStructs: unknown; pendingDs: unknown };
    if (store.pendingStructs !== null || store.pendingDs !== null) {
      store.pendingStructs = null;
      store.pendingDs = null;
      unreadable = true;
    }
    let result: DocReceiveResult = unreadable
      ? { status: "error", code: "resync", message: "Update could not be read; resyncing." }
      : { status: "applied" };
    if (undo) {
      const locked = context.lockedLayerIds.find((id) => touched.has(id));
      if (locked) {
        undo.undo();
        const layer = this.project.layers.get(locked);
        const name = layer instanceof Y.Map ? layer.get("name") : undefined;
        result = { status: "reverted", layerName: typeof name === "string" ? name : locked };
      }
      // clear() releases the deleted content the manager kept for undo, so
      // it can be garbage collected; destroy() alone only detaches it.
      undo.clear();
      undo.destroy();
    }
    const tampered = protectedBefore.filter(
      ([key, value]) => this.project.fields.get(key) !== value,
    );
    if (tampered.length) {
      doc.transact(() => {
        for (const [key, value] of tampered) {
          if (value === undefined) this.project.fields.delete(key);
          else this.project.fields.set(key, value);
        }
      }, RELAY_DOC_ORIGIN);
    }
    this.maybeCompact();
    return result;
  }

  /** Drop a client's half-received update (it left or will resync). */
  forget(clientId: string): void {
    this.assembler.forget(clientId);
  }

  /**
   * Apply a whole-project snapshot from a client on the snapshot protocol, as
   * the differences from the current document.
   */
  writeSnapshot(project: ProjectRecord, clientId: string): void {
    this.project.write(project, { clientId } satisfies ClientOrigin);
    this.maybeCompact();
  }

  /** Replace one top-level project field (the relay's comment list). */
  setField(key: string, value: unknown): void {
    this.project.doc.transact(() => {
      if (value === undefined) this.project.fields.delete(key);
      else this.project.fields.set(key, value);
    }, RELAY_DOC_ORIGIN);
    this.maybeCompact();
  }

  /** The project as plain JSON, for snapshot-protocol clients. */
  materialize(): ProjectRecord {
    return this.project.read();
  }

  /** Fold the log into a new base state now. */
  compact(): void {
    const state = Y.encodeStateAsUpdate(this.project.doc);
    this.storage.replace(state);
    this.baseBytes = state.length;
    this.logBytes = 0;
    this.logEntries = 0;
  }

  private maybeCompact(): void {
    // Each compaction rewrites the whole base, so scale the trigger with it:
    // a big document is not rewritten after a few hundred tiny edits.
    const bytesDue = this.logBytes >= Math.max(DOC_COMPACT_LOG_BYTES, this.baseBytes / 2);
    const entriesDue =
      this.logEntries >= DOC_COMPACT_LOG_ENTRIES && this.logBytes * 4 >= this.baseBytes;
    if (bytesDue || entriesDue) this.compact();
  }
}

/** Frame an update for the wire as one or more `doc-update` messages. */
export function docUpdateMessages(
  update: Uint8Array,
  origin: string,
  rev: number,
  makeId: () => string,
): ServerDocUpdateMessage[] {
  return splitUpdate(update, makeId).map((frame) => ({
    type: "doc-update",
    ...frame,
    origin,
    rev,
  }));
}

function tooLargeMessage(): string {
  return "Project is too large to sync live. Share it via URL instead.";
}
