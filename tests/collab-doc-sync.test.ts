// Client-side op-level sync (#3530): two `CollabDocSync` instances talking to
// an in-process relay built on the real `RelayDoc`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as crdt from "../packages/collab-core/src/crdt";
import {
  RelayDoc,
  docUpdateMessages,
  type DocStorage,
} from "../packages/collab-core/src/crdt-relay";
import { CollabDocSync, LOCAL_ONLY_KEYS } from "../apps/geolibre-desktop/src/lib/collab-doc-sync";
import type {
  ClientMessage,
  ServerMessage,
} from "../apps/geolibre-desktop/src/lib/collab-protocol";
import type { GeoLibreProject } from "../packages/core/src/types";
import { canUndoProjectRestore, redo, setHistoryDelegate, undo } from "../packages/core/src/store";

function memoryStorage(): DocStorage {
  let base: Uint8Array | null = null;
  let log: Uint8Array[] = [];
  return {
    load: () => ({ base, log: [...log] }),
    append: (update) => void log.push(update),
    replace: (next) => {
      base = next;
      log = [];
    },
  };
}

interface Peer {
  id: string;
  sync: CollabDocSync;
  store: { project: GeoLibreProject | null; applies: { initial: boolean }[] };
  canEdit: boolean;
  /** What the relay allows, which can briefly disagree with the client. */
  relayCanEdit: boolean;
  online: boolean;
}

/** A relay that delivers frames on later ticks, like a socket would. */
class FakeRelay {
  readonly doc: RelayDoc;
  readonly peers = new Map<string, Peer>();
  lockedLayerIds: string[] = [];
  rev = 0;

  constructor() {
    this.doc = new RelayDoc({
      storage: memoryStorage(),
      onUpdate: (update, origin) => {
        this.rev += 1;
        for (const message of docUpdateMessages(update, origin, this.rev, () => "r")) {
          for (const peer of this.peers.values()) {
            if (peer.id !== origin) this.deliver(peer, message as ServerMessage);
          }
        }
      },
    });
  }

  deliver(peer: Peer, message: ServerMessage): void {
    setImmediate(() => {
      if (peer.online) peer.sync.handle(message);
    });
  }

  receive(peer: Peer, message: ClientMessage): void {
    if (!peer.online) return;
    setImmediate(() => {
      if (message.type === "doc-sync") {
        for (const frame of this.doc.framesFor(message.stateVector, () => "s")!) {
          this.deliver(peer, { type: "doc-update", ...frame, origin: "relay", rev: this.rev });
        }
        this.deliver(peer, {
          type: "doc-synced",
          stateVector: this.doc.stateVector(),
          rev: this.rev,
        });
      } else if (message.type === "doc-update") {
        const result = this.doc.receive(peer.id, message, {
          canEdit: peer.relayCanEdit,
          isHost: peer.id === "host",
          lockedLayerIds: this.lockedLayerIds,
        });
        if (result.status === "error") {
          this.deliver(peer, { type: "error", code: result.code, message: result.message });
        } else if (result.status === "reverted") {
          this.deliver(peer, { type: "error", code: "layer-locked", message: "locked" });
        }
      }
    });
  }

  join(id: string, localProject: GeoLibreProject | null, canEdit = true): Peer {
    const peer = {
      id,
      canEdit,
      relayCanEdit: canEdit,
      online: true,
      store: { project: localProject, applies: [] as { initial: boolean }[] },
    } as Peer;
    peer.sync = new CollabDocSync(crdt, {
      send: (message) => {
        this.receive(peer, message);
        return peer.online;
      },
      applyProject: (project, initial) => {
        peer.store.project = project;
        peer.store.applies.push({ initial });
      },
      seedProject: async () => peer.store.project,
      canEdit: () => peer.canEdit,
      isHost: () => id === "host",
      applyDelayMs: 0,
    });
    this.peers.set(id, peer);
    peer.sync.start();
    return peer;
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function project(name = "Shared"): GeoLibreProject {
  return {
    version: 1,
    projectName: name,
    mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
    layers: [
      { id: "roads", name: "Roads", style: { color: "#f00", width: 1 } },
      { id: "parcels", name: "Parcels" },
    ],
  } as unknown as GeoLibreProject;
}

type AnyLayer = { id: string; name?: string; style?: Record<string, unknown> };

function rename(p: GeoLibreProject, id: string, name: string): GeoLibreProject {
  return {
    ...p,
    layers: (p.layers as unknown as AnyLayer[]).map((l) => (l.id === id ? { ...l, name } : l)),
  } as unknown as GeoLibreProject;
}

/** Push an edit the way the app does: derived from, and based on, the store's project. */
function edit(peer: Peer, change: (p: GeoLibreProject) => GeoLibreProject): void {
  const base = peer.store.project ?? peer.sync.read();
  peer.sync.pushLocal(change(base), base);
}

function names(p: GeoLibreProject | null): string[] {
  return ((p?.layers ?? []) as unknown as AnyLayer[]).map((l) => l.name ?? "");
}

describe("CollabDocSync", () => {
  it("seeds an empty session from the host and loads it into a joining guest", async () => {
    const relay = new FakeRelay();
    const host = relay.join("host", project());
    await settle();
    assert.ok(host.sync.isSynced);
    assert.deepEqual(names(relay.doc.materialize() as unknown as GeoLibreProject), [
      "Roads",
      "Parcels",
    ]);
    assert.equal(relay.doc.materialize().mapView, undefined, "the host's camera stays local");

    const guest = relay.join("guest", project("Guest's own"));
    await settle();
    assert.deepEqual(guest.store.applies, [{ initial: true }]);
    assert.equal(
      (guest.store.project as unknown as { projectName?: string }).projectName,
      "Shared",
    );
  });

  it("merges concurrent edits and keeps each user's undo to their own edits", async () => {
    const relay = new FakeRelay();
    const host = relay.join("host", project());
    await settle();
    const guest = relay.join("guest", null);
    await settle();

    edit(host, (p) => rename(p, "roads", "Roads (host)"));
    edit(guest, (p) => rename(p, "parcels", "Parcels (guest)"));
    await settle();
    assert.deepEqual(names(host.store.project), ["Roads (host)", "Parcels (guest)"]);
    assert.deepEqual(names(guest.store.project), ["Roads (host)", "Parcels (guest)"]);

    assert.ok(host.sync.canUndo());
    host.sync.undo();
    await settle();
    // The host's undo reverted the host's rename only, everywhere.
    assert.deepEqual(names(host.store.project), ["Roads", "Parcels (guest)"]);
    assert.deepEqual(names(guest.store.project), ["Roads", "Parcels (guest)"]);
    // The guest's own history is untouched by it.
    guest.sync.undo();
    await settle();
    assert.deepEqual(names(host.store.project), ["Roads", "Parcels"]);
    host.sync.redo();
    await settle();
    assert.deepEqual(names(guest.store.project), ["Roads (host)", "Parcels"]);
  });

  it("keeps a peer's edit the store has not taken yet", async () => {
    const relay = new FakeRelay();
    const host = relay.join("host", project());
    await settle();
    const guest = relay.join("guest", null);
    await settle();
    const stale = guest.store.project!;
    edit(host, (p) => rename(p, "roads", "Roads (host)"));
    await settle();
    // The guest's next edit still derives from its older store copy.
    guest.sync.pushLocal(rename(stale, "parcels", "Parcels (guest)"), stale);
    await settle();
    assert.deepEqual(names(relay.doc.materialize() as unknown as GeoLibreProject), [
      "Roads (host)",
      "Parcels (guest)",
    ]);
  });

  it("never writes participant-local keys", async () => {
    const relay = new FakeRelay();
    const host = relay.join("host", project());
    await settle();
    edit(
      host,
      (p) =>
        ({
          ...p,
          mapView: { center: [9, 9], zoom: 9, bearing: 0, pitch: 0 },
          selectedLayerId: "roads",
        }) as unknown as GeoLibreProject,
    );
    await settle();
    for (const key of LOCAL_ONLY_KEYS) {
      if (key !== "comments") assert.equal(relay.doc.materialize()[key], undefined, key);
    }
  });

  it("sends edits made while offline on the next sync", async () => {
    const relay = new FakeRelay();
    const host = relay.join("host", project());
    await settle();
    const guest = relay.join("guest", null);
    await settle();
    guest.online = false;
    edit(guest, (p) => rename(p, "roads", "Offline edit"));
    await settle();
    assert.deepEqual(names(host.store.project), ["Roads", "Parcels"]);
    guest.online = true;
    guest.sync.start();
    await settle();
    assert.deepEqual(names(host.store.project), ["Offline edit", "Parcels"]);
  });

  it("does not push for a view-only participant and recovers from a refused update", async () => {
    const relay = new FakeRelay();
    const host = relay.join("host", project());
    await settle();
    const guest = relay.join("guest", null, false);
    await settle();
    edit(guest, (p) => rename(p, "roads", "Ignored"));
    await settle();
    assert.deepEqual(names(relay.doc.materialize() as unknown as GeoLibreProject), [
      "Roads",
      "Parcels",
    ]);

    // Edit rights flip mid-flight: the relay refuses, the client starts over
    // from the relay's copy and later edits sync again.
    guest.canEdit = true;
    guest.relayCanEdit = false;
    edit(guest, (p) => rename(p, "roads", "Refused"));
    await settle();
    guest.relayCanEdit = true;
    await settle();
    assert.deepEqual(names(guest.store.project), ["Roads", "Parcels"]);
    edit(guest, (p) => rename(p, "parcels", "Accepted"));
    await settle();
    assert.deepEqual(names(host.store.project), ["Roads", "Accepted"]);
  });

  it("converges on a locked layer the relay reverted", async () => {
    const relay = new FakeRelay();
    const host = relay.join("host", project());
    await settle();
    relay.lockedLayerIds = ["roads"];
    const guest = relay.join("guest", null);
    await settle();
    edit(guest, (p) => rename(p, "roads", "Hijacked"));
    await settle();
    assert.deepEqual(names(guest.store.project), ["Roads", "Parcels"]);
    assert.deepEqual(names(host.store.project ?? host.sync.read()), ["Roads", "Parcels"]);
  });
});

describe("store history delegate", () => {
  it("routes undo/redo and availability to the delegate while installed", () => {
    const calls: string[] = [];
    let available = false;
    setHistoryDelegate({
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
      canUndo: () => available,
      canRedo: () => available,
    });
    try {
      assert.equal(canUndoProjectRestore(), false);
      available = true;
      assert.equal(canUndoProjectRestore(), true);
      undo();
      redo();
      assert.deepEqual(calls, ["undo", "redo"]);
    } finally {
      setHistoryDelegate(null);
    }
    assert.equal(canUndoProjectRestore(), false);
    undo();
    assert.deepEqual(calls, ["undo", "redo"]);
  });
});
