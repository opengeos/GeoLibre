import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLocalUndoManager,
  decodeBase64,
  deepEqual,
  encodeBase64,
  MAX_UPDATE_CHUNK_BYTES,
  ProjectDoc,
  splitUpdate,
  UpdateAssembler,
  Y,
  type ProjectRecord,
} from "../packages/collab-core/src/crdt";

type Feature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Record<string, unknown>;
};

function feature(i: number, extra: Record<string, unknown> = {}): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [i, -i] },
    properties: { n: i, ...extra },
  };
}

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    version: 1,
    projectName: "Shared",
    basemapStyleUrl: "https://example.test/style.json",
    layerGroups: [],
    layers: [
      {
        id: "roads",
        name: "Roads",
        type: "geojson",
        visible: true,
        opacity: 1,
        style: { fillColor: "#ff0000", lineWidth: 1, fillOpacity: 0.5 },
        geojson: {
          type: "FeatureCollection",
          features: [feature(0), feature(1), feature(2), feature(3)],
        },
      },
      {
        id: "parcels",
        name: "Parcels",
        type: "geojson",
        visible: true,
        opacity: 1,
        style: { fillColor: "#00ff00" },
      },
    ],
    ...overrides,
  };
}

/** Two clients that exchange updates only when told to (a partitioned network). */
function pair(): { a: ProjectDoc; b: ProjectDoc; sync: () => void } {
  const a = new ProjectDoc(new Y.Doc());
  const b = new ProjectDoc(new Y.Doc());
  const sync = () => {
    const toB = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
    const toA = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
    Y.applyUpdate(b.doc, toB, "remote");
    Y.applyUpdate(a.doc, toA, "remote");
  };
  return { a, b, sync };
}

type Layer = Record<string, unknown> & {
  id: string;
  style?: Record<string, unknown>;
  geojson?: { type: string; features: Feature[] };
};

function layers(p: ProjectRecord): Layer[] {
  return p.layers as Layer[];
}

function withLayer(p: ProjectRecord, id: string, edit: (layer: Layer) => Layer): ProjectRecord {
  return { ...p, layers: layers(p).map((layer) => (layer.id === id ? edit(layer) : layer)) };
}

describe("ProjectDoc", () => {
  it("round-trips a project, including a feature collection", () => {
    const doc = new ProjectDoc();
    const source = project();
    doc.write(source, "local");
    assert.ok(deepEqual(doc.read(), source));
  });

  it("deletes whatever a written project lacks (callers write only after syncing)", () => {
    const doc = new ProjectDoc();
    doc.write(project(), "local");
    doc.write({ layers: [] }, "local");
    assert.deepEqual(doc.read(), { layers: [] });
  });

  it("leaves ignored top-level keys alone on write", () => {
    const doc = new ProjectDoc();
    doc.write(project({ mapView: { zoom: 3 } }), "local");
    doc.write(project(), "local", { ignore: new Set(["mapView"]) });
    assert.deepEqual(doc.read().mapView, { zoom: 3 });
    doc.write(project(), "local");
    assert.equal(doc.read().mapView, undefined);
  });

  it("merges concurrent edits to different properties, layers and features", () => {
    const { a, b, sync } = pair();
    a.write(project(), "local");
    sync();
    const base = b.read();

    // A recolours roads, moves feature 0 and adds a layer; B changes the line
    // width of the same layer, edits feature 3 and adds another layer.
    let editA = withLayer(base, "roads", (layer) => ({
      ...layer,
      style: { ...layer.style, fillColor: "#0000ff" },
      geojson: {
        type: "FeatureCollection",
        features: layer.geojson!.features.map((f, i) => (i === 0 ? feature(100) : f)),
      },
    }));
    editA = { ...editA, layers: [...layers(editA), { id: "a-new", name: "From A" }] };
    let editB = withLayer(base, "roads", (layer) => ({
      ...layer,
      style: { ...layer.style, lineWidth: 4 },
      geojson: {
        type: "FeatureCollection",
        features: layer.geojson!.features.map((f, i) => (i === 3 ? feature(300) : f)),
      },
    }));
    editB = { ...editB, layers: [...layers(editB), { id: "b-new", name: "From B" }] };
    a.write(editA, "local");
    b.write(editB, "local");
    sync();

    const merged = a.read();
    assert.ok(deepEqual(merged, b.read()), "both clients converge");
    const roads = layers(merged).find((layer) => layer.id === "roads")!;
    assert.equal(roads.style!.fillColor, "#0000ff");
    assert.equal(roads.style!.lineWidth, 4);
    assert.equal(roads.style!.fillOpacity, 0.5);
    assert.deepEqual(
      roads.geojson!.features.map((f) => f.properties.n),
      [100, 1, 2, 300],
    );
    const ids = layers(merged).map((layer) => layer.id);
    assert.deepEqual(ids.slice(0, 2), ["roads", "parcels"]);
    assert.deepEqual([...ids.slice(2)].sort(), ["a-new", "b-new"]);
  });

  it("merges concurrent feature inserts and deletes in one layer", () => {
    const { a, b, sync } = pair();
    a.write(project(), "local");
    sync();
    const base = b.read();
    const edit = (p: ProjectRecord, fn: (features: Feature[]) => Feature[]) =>
      withLayer(p, "roads", (layer) => ({
        ...layer,
        geojson: { type: "FeatureCollection", features: fn(layer.geojson!.features) },
      }));
    a.write(
      edit(base, (fs) => [...fs, feature(4)]),
      "local",
    );
    b.write(
      edit(base, (fs) => fs.filter((f) => f.properties.n !== 1)),
      "local",
    );
    sync();
    const features = layers(a.read()).find((l) => l.id === "roads")!.geojson!.features;
    assert.deepEqual(
      features.map((f) => f.properties.n),
      [0, 2, 3, 4],
    );
    assert.ok(deepEqual(a.read(), b.read()));
  });

  it("keeps an unchanged feature's key when its neighbours are deleted", () => {
    const { a, b, sync } = pair();
    a.write(project(), "local");
    sync();
    const edit = (p: ProjectRecord, fn: (features: Feature[]) => Feature[]) =>
      withLayer(p, "roads", (layer) => ({
        ...layer,
        geojson: { type: "FeatureCollection", features: fn(layer.geojson!.features) },
      }));
    // A deletes features 0 and 2; B edits feature 1 at the same time.
    a.write(
      edit(a.read(), (fs) => fs.filter((f) => (f.properties.n as number) % 2 === 1)),
      "local",
    );
    b.write(
      edit(b.read(), (fs) => fs.map((f) => (f.properties.n === 1 ? feature(1, { b: true }) : f))),
      "local",
    );
    sync();
    const features = layers(a.read()).find((l) => l.id === "roads")!.geojson!.features;
    assert.deepEqual(features, [feature(1, { b: true }), feature(3)]);
    assert.ok(deepEqual(a.read(), b.read()));
  });

  it("never reuses a feature key across two wrappers of one document", () => {
    const doc = new Y.Doc();
    const first = new ProjectDoc(doc);
    first.write(project(), "local");
    const second = new ProjectDoc(doc);
    second.write(
      withLayer(second.read(), "roads", (layer) => ({
        ...layer,
        geojson: {
          type: "FeatureCollection",
          features: [...layer.geojson!.features, feature(4)],
        },
      })),
      "local",
    );
    const features = layers(first.read()).find((l) => l.id === "roads")!.geojson!.features;
    assert.equal(features.length, 5);
  });

  it("does not cache a written value an update handler replaced", () => {
    const doc = new ProjectDoc();
    doc.write(project(), "local");
    let rewrite = true;
    doc.doc.on("update", () => {
      if (!rewrite) return;
      rewrite = false;
      doc.doc.transact(() => doc.fields.set("projectName", "From handler"), "handler");
    });
    doc.write({ ...doc.read(), projectName: "From write" }, "local");
    assert.equal(doc.fields.get("projectName"), "From handler");
    assert.equal(doc.read().projectName, "From handler");
  });

  it("converges when both clients set the same value at once", () => {
    const { a, b, sync } = pair();
    a.write(project(), "local");
    sync();
    a.write({ ...a.read(), projectName: "From A" }, "local");
    b.write({ ...b.read(), projectName: "From B" }, "local");
    sync();
    assert.equal(a.read().projectName, b.read().projectName);
    assert.ok(["From A", "From B"].includes(a.read().projectName as string));
  });

  it("lets a delete win over a concurrent edit of the deleted layer", () => {
    const { a, b, sync } = pair();
    a.write(project(), "local");
    sync();
    a.write({ ...a.read(), layers: layers(a.read()).filter((l) => l.id !== "parcels") }, "local");
    b.write(
      withLayer(b.read(), "parcels", (layer) => ({ ...layer, name: "Renamed" })),
      "local",
    );
    sync();
    assert.deepEqual(
      layers(a.read()).map((l) => l.id),
      ["roads"],
    );
    assert.ok(deepEqual(a.read(), b.read()));
  });

  it("never duplicates a layer moved by two clients at once", () => {
    const { a, b, sync } = pair();
    const three = project({
      layers: [{ id: "x" }, { id: "y" }, { id: "z" }],
    });
    a.write(three, "local");
    sync();
    a.write(project({ layers: [{ id: "y" }, { id: "z" }, { id: "x" }] }), "local");
    b.write(project({ layers: [{ id: "y" }, { id: "x" }, { id: "z" }] }), "local");
    sync();
    const ids = layers(a.read()).map((l) => l.id);
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(
      ids,
      layers(b.read()).map((l) => l.id),
    );
    // A later write compacts the duplicate entry out of the order array.
    a.write(a.read(), "local");
    assert.equal(a.layerOrder.length, 3);
  });

  it("reuses unchanged layer objects across a remote update", () => {
    const { a, b, sync } = pair();
    a.write(project(), "local");
    sync();
    const before = b.read();
    a.write(
      withLayer(a.read(), "parcels", (l) => ({ ...l, opacity: 0.4 })),
      "local",
    );
    sync();
    const after = b.read();
    assert.equal(layers(after)[0], layers(before)[0], "roads keeps its identity");
    assert.notEqual(layers(after)[1], layers(before)[1]);
    assert.equal(layers(after)[1].opacity, 0.4);
  });

  it("records an edit to one feature of a large layer as a small update", () => {
    const doc = new ProjectDoc();
    const big = project({
      layers: [
        {
          id: "big",
          geojson: {
            type: "FeatureCollection",
            features: Array.from({ length: 5000 }, (_, i) => feature(i)),
          },
        },
      ],
    });
    doc.write(big, "local");
    const updates: Uint8Array[] = [];
    doc.doc.on("update", (u: Uint8Array) => updates.push(u));
    doc.write(
      withLayer(doc.read(), "big", (layer) => ({
        ...layer,
        geojson: {
          type: "FeatureCollection",
          features: layer.geojson!.features.map((f, i) => (i === 2500 ? feature(-1) : f)),
        },
      })),
      "local",
    );
    assert.equal(updates.length, 1);
    assert.ok(updates[0].length < 512, `update was ${updates[0].length} bytes`);
    // Re-writing the identical project records nothing.
    doc.write(doc.read(), "local");
    assert.equal(updates.length, 1);
  });
});

describe("feature identity and edge cases", () => {
  it("keeps features with GeoJSON ids on their own keys", () => {
    const { a, b, sync } = pair();
    const withIds = (fs: Feature[]) =>
      project({
        layers: [{ id: "roads", geojson: { type: "FeatureCollection", features: fs } }],
      });
    const A = { ...feature(0), id: "A" };
    const B = { ...feature(1), id: "B" };
    const C = { ...feature(2), id: "C" };
    a.write(withIds([A, B, C]), "local");
    sync();
    // A deletes feature A and edits B; B edits feature A at the same time.
    a.write(withIds([{ ...B, properties: { n: 10 } }, C]), "local");
    b.write(withIds([{ ...A, properties: { n: 99 } }, B, C]), "local");
    sync();
    const features = layers(a.read())[0].geojson!.features as (Feature & { id: string })[];
    assert.deepEqual(
      features.map((f) => [f.id, f.properties.n]),
      [
        ["B", 10],
        ["C", 2],
      ],
    );
    assert.ok(deepEqual(a.read(), b.read()));
  });

  it("deletes an omitted field even when its name is inherited", () => {
    const doc = new ProjectDoc();
    doc.write(project({ constructor: "x" } as Partial<ProjectRecord>), "local");
    doc.write(project(), "local");
    assert.equal(Object.prototype.hasOwnProperty.call(doc.read(), "constructor"), false);
  });

  it("survives malformed entries a peer could store", () => {
    const doc = new ProjectDoc();
    doc.write(project(), "local");
    doc.doc.transact(() => {
      doc.layers.set("bogus", null as unknown as Y.Map<unknown>);
      doc.layerOrder.push(["bogus"]);
      const roads = doc.layers.get("roads")!;
      (roads.get("geojson") as Y.Map<unknown>).delete("meta");
    });
    assert.deepEqual(
      layers(doc.read()).map((l) => l.id),
      ["roads", "parcels"],
    );
    doc.write(
      withLayer(doc.read(), "roads", (l) => ({
        ...l,
        geojson: { ...l.geojson!, name: "renamed" } as Layer["geojson"],
      })),
      "local",
    );
    assert.equal((layers(doc.read())[0].geojson as { name?: string }).name, "renamed");
  });

  it("strips a __proto__ key a remote update smuggles into a feature", () => {
    const sender = new ProjectDoc();
    const poisoned = JSON.parse(
      '{"type":"Feature","geometry":null,"properties":{"__proto__":{"admin":true},"n":1}}',
    );
    sender.write(
      project({
        layers: [{ id: "x", geojson: { type: "FeatureCollection", features: [poisoned] } }],
      }),
      "local",
    );
    const receiver = new ProjectDoc();
    Y.applyUpdate(receiver.doc, Y.encodeStateAsUpdate(sender.doc), "remote");
    const props = (layers(receiver.read())[0].geojson!.features[0] as Feature).properties;
    assert.equal(Object.getPrototypeOf(props), Object.prototype);
    assert.equal((props as { admin?: boolean }).admin, undefined);
    assert.equal(props.n, 1);
  });

  it("rebuilds a poisoned object hidden behind a number in an array", () => {
    const sender = new ProjectDoc();
    sender.write(project({ extra: JSON.parse('[1, {"__proto__": {"admin": true}}]') }), "local");
    const receiver = new ProjectDoc();
    Y.applyUpdate(receiver.doc, Y.encodeStateAsUpdate(sender.doc), "remote");
    const extra = receiver.read().extra as unknown[];
    assert.equal(Object.getPrototypeOf(extra[1]), Object.prototype);
  });

  it("keeps a top-level __proto__ field as data", () => {
    const doc = new ProjectDoc();
    doc.doc.transact(() => doc.fields.set("__proto__", { polluted: true }));
    const read = doc.read();
    assert.equal(Object.getPrototypeOf(read), Object.prototype);
    assert.ok(Object.keys(read).includes("__proto__"));
  });

  it("keeps the cache right when a write re-enters from an update handler", () => {
    const doc = new ProjectDoc();
    doc.write(project(), "local");
    let reenter = true;
    doc.doc.on("update", () => {
      if (!reenter) return;
      reenter = false;
      doc.write({ ...doc.read(), projectName: "Inner" }, "handler");
    });
    doc.write({ ...doc.read(), projectName: "Outer" }, "local");
    assert.equal(doc.fields.get("projectName"), "Inner");
    assert.equal(doc.read().projectName, "Inner");
  });

  it("writes correctly inside a caller's transaction", () => {
    const doc = new ProjectDoc();
    const source = project();
    doc.write(source, "local");
    doc.doc.transact(() => {
      doc.fields.set("projectName", "Direct");
      doc.write(source, "local");
    });
    assert.equal(doc.read().projectName, "Shared");
  });

  it("stops observing after destroy", () => {
    const doc = new ProjectDoc();
    doc.write(project(), "local");
    const before = doc.read();
    doc.destroy();
    doc.fields.set("projectName", "Changed");
    assert.equal(before.projectName, "Shared");
    assert.throws(() => doc.read(), TypeError);
    assert.throws(() => doc.write(project(), "local"), TypeError);
  });

  it("refuses a chunk id the assembler would reject", () => {
    const big = new Uint8Array(MAX_UPDATE_CHUNK_BYTES + 1);
    assert.throws(() => splitUpdate(big, () => "x".repeat(65)), RangeError);
    assert.equal(splitUpdate(new Uint8Array(3), () => "").length, 1);
  });

  it("records no transaction from a constructor-matched origin", () => {
    const doc = new ProjectDoc();
    const undo = createLocalUndoManager(doc, Object, 0);
    doc.write(project(), {});
    assert.equal(undo.undoStack.length, 0);
    doc.write({ ...doc.read(), projectName: "Mine" }, Object);
    assert.equal(undo.undoStack.length, 1);
  });
});

describe("untrusted keys", () => {
  it("keeps a remote __proto__ key as data, not as the prototype", () => {
    const doc = new ProjectDoc();
    doc.doc.transact(() => {
      const meta = new Y.Map<unknown>();
      meta.set("__proto__", { polluted: true });
      doc.fields.set("metadata", meta);
    });
    const metadata = doc.read().metadata as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(metadata), Object.prototype);
    assert.deepEqual(Object.keys(metadata), ["__proto__"]);
    assert.equal((metadata as { polluted?: boolean }).polluted, undefined);
  });
});

describe("ProjectDoc.writeChanges (three-way)", () => {
  it("writes only the writer's change and keeps a peer's newer edit", () => {
    const { a, b, sync } = pair();
    a.write(project(), "local");
    sync();
    const base = a.read();
    // B recolours roads; A has not applied that to its store yet.
    b.write(
      withLayer(b.read(), "roads", (l) => ({ ...l, style: { ...l.style, fillColor: "#0f0" } })),
      "local",
    );
    sync();
    // A's store still holds the old colour, plus A's own opacity change.
    a.writeChanges(
      withLayer(base, "roads", (l) => ({ ...l, opacity: 0.4 })),
      base,
      "local",
    );
    sync();
    for (const doc of [a, b]) {
      const roads = layers(doc.read())[0];
      assert.equal(roads.opacity, 0.4);
      assert.equal(roads.style!.fillColor, "#0f0");
    }
  });

  it("neither resurrects a layer a peer deleted nor drops one a peer added", () => {
    const { a, b, sync } = pair();
    a.write(project(), "local");
    sync();
    const base = a.read();
    b.write(
      {
        ...b.read(),
        layers: [...layers(b.read()).filter((l) => l.id !== "parcels"), { id: "new" }],
      },
      "local",
    );
    sync();
    a.writeChanges(
      withLayer(base, "parcels", (l) => ({ ...l, name: "Edited" })),
      base,
      "local",
    );
    assert.deepEqual(
      layers(a.read()).map((l) => l.id),
      ["roads", "new"],
    );
    // A's own new layer lands after the layer before it in A's list.
    a.writeChanges(
      { ...base, layers: [layers(base)[0], { id: "mine" }, layers(base)[1]] },
      base,
      "local",
    );
    assert.deepEqual(
      layers(a.read()).map((l) => l.id),
      ["roads", "mine", "new"],
    );
  });

  it("keeps a peer's move unless the writer moved layers itself", () => {
    const { a, b, sync } = pair();
    a.write(project({ layers: [{ id: "x" }, { id: "y" }, { id: "z" }] }), "local");
    sync();
    const base = a.read();
    b.write(project({ layers: [{ id: "z" }, { id: "x" }, { id: "y" }] }), "local");
    sync();
    a.writeChanges({ ...base, projectName: "Renamed" }, base, "local");
    assert.deepEqual(
      layers(a.read()).map((l) => l.id),
      ["z", "x", "y"],
    );
    a.writeChanges({ ...base, layers: [{ id: "y" }, { id: "x" }, { id: "z" }] }, base, "local");
    assert.deepEqual(
      layers(a.read()).map((l) => l.id),
      ["y", "x", "z"],
    );
  });

  it("merges feature edits against a stale base", () => {
    const { a, b, sync } = pair();
    a.write(project(), "local");
    sync();
    const base = a.read();
    const edit = (p: ProjectRecord, fn: (features: Feature[]) => Feature[]) =>
      withLayer(p, "roads", (layer) => ({
        ...layer,
        geojson: { type: "FeatureCollection", features: fn(layer.geojson!.features) },
      }));
    b.write(
      edit(b.read(), (fs) => [
        ...fs.map((f, i) => (i === 1 ? feature(1, { b: 1 }) : f)),
        feature(9),
      ]),
      "local",
    );
    sync();
    a.writeChanges(
      edit(base, (fs) => [fs[0], feature(5), fs[1], fs[3]]),
      base,
      "local",
    );
    sync();
    const features = layers(a.read())[0].geojson!.features;
    assert.deepEqual(features, [
      feature(0),
      feature(5),
      feature(1, { b: 1 }),
      feature(3),
      feature(9),
    ]);
    assert.ok(deepEqual(a.read(), b.read()));
  });
});

describe("writeChanges feature edge cases", () => {
  const fc = (fs: unknown[]) =>
    project({ layers: [{ id: "x", geojson: { type: "FeatureCollection", features: fs } }] });
  const ids = (p: ProjectRecord) =>
    (layers(p)[0].geojson!.features as unknown as { id: string }[]).map((f) => f.id);
  const f = (id: string) => ({ type: "Feature", id, geometry: null, properties: {} });

  it("anchors an insertion on the nearest surviving predecessor", () => {
    const { a, b, sync } = pair();
    a.write(fc([f("A"), f("B"), f("C")]), "local");
    sync();
    const base = a.read();
    b.write(fc([f("A"), f("C")]), "local");
    sync();
    a.writeChanges(fc([f("A"), f("B"), f("X"), f("C")]), base, "local");
    assert.deepEqual(ids(a.read()), ["A", "X", "C"]);
  });

  it("does not bring back a feature a peer deleted when the writer moves it", () => {
    const { a, b, sync } = pair();
    a.write(fc([f("A"), f("B")]), "local");
    sync();
    const base = a.read();
    b.write(fc([f("B")]), "local");
    sync();
    a.writeChanges(fc([f("B"), f("A")]), base, "local");
    assert.deepEqual(ids(a.read()), ["B"]);
  });

  it("recreates missing collection metadata when patching", () => {
    const doc = new ProjectDoc();
    doc.write(fc([f("A")]), "local");
    const base = doc.read();
    const roads = doc.layers.get("x")!;
    (roads.get("geojson") as Y.Map<unknown>).delete("meta");
    const named = {
      ...base,
      layers: [{ ...layers(base)[0], geojson: { ...layers(base)[0].geojson!, name: "n" } }],
    };
    doc.writeChanges(named, base, "local");
    assert.equal((layers(doc.read())[0].geojson as { name?: string }).name, "n");
  });

  it("clears a large collection in one pass", () => {
    const doc = new ProjectDoc();
    const many = Array.from({ length: 20_000 }, (_, i) => f(`f${i}`));
    doc.write(fc(many), "local");
    const base = doc.read();
    doc.writeChanges(fc([]), base, "local");
    assert.equal(ids(doc.read()).length, 0);
  });
});

describe("per-user undo", () => {
  it("refuses a null local origin", () => {
    assert.throws(() => createLocalUndoManager(new ProjectDoc(), null), TypeError);
  });

  it("undoes only the local user's edits", () => {
    const { a, b, sync } = pair();
    a.write(project(), "init");
    sync();
    const undoA = createLocalUndoManager(a, "local", 0);
    const undoB = createLocalUndoManager(b, "local", 0);

    a.write(
      withLayer(a.read(), "roads", (l) => ({ ...l, name: "Roads (A)" })),
      "local",
    );
    sync();
    b.write(
      withLayer(b.read(), "parcels", (l) => ({ ...l, name: "Parcels (B)" })),
      "local",
    );
    sync();

    assert.equal(undoA.undoStack.length, 1, "A's stack holds only A's edit");
    assert.equal(undoB.undoStack.length, 1, "B's stack holds only B's edit");
    undoA.undo();
    sync();
    for (const doc of [a, b]) {
      const names = layers(doc.read()).map((l) => l.name);
      assert.deepEqual(names, ["Roads", "Parcels (B)"]);
    }
    // B's history survives A's undo: B can still undo its own edit.
    undoB.undo();
    sync();
    assert.deepEqual(
      layers(a.read()).map((l) => l.name),
      ["Roads", "Parcels"],
    );
    undoA.redo();
    sync();
    assert.equal(layers(b.read())[0].name, "Roads (A)");
  });
});

describe("update framing", () => {
  it("base64 matches Node's encoder and round-trips", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 1000, 70_001]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + 11) & 255);
      const text = encodeBase64(bytes);
      assert.equal(text, Buffer.from(bytes).toString("base64"));
      assert.deepEqual(decodeBase64(text), bytes);
    }
    assert.equal(decodeBase64("abc"), null);
    assert.equal(decodeBase64("ab!d"), null);
    assert.equal(decodeBase64(42), null);
  });

  it("syncs a project far beyond the old 10 MB snapshot cap in bounded frames", () => {
    const sender = new ProjectDoc();
    const padding = "x".repeat(2_000);
    const features = Array.from({ length: 6_500 }, (_, i) => feature(i, { padding }));
    const big = project({
      layers: [{ id: "big", geojson: { type: "FeatureCollection", features } }],
    });
    assert.ok(JSON.stringify(big).length > 12_000_000, "the project is larger than 12 MB");
    sender.write(big, "local");
    const update = Y.encodeStateAsUpdate(sender.doc);
    let n = 0;
    const frames = splitUpdate(update, () => `u${++n}`);
    assert.ok(frames.length > 20);
    for (const frame of frames) {
      assert.ok(JSON.stringify({ type: "doc-update", ...frame }).length < 1_000_000);
    }

    const receiver = new ProjectDoc();
    const assembler = new UpdateAssembler(64 * 1024 * 1024);
    let complete: Uint8Array | null = null;
    for (const frame of frames) {
      const result = assembler.push("peer", frame);
      if (result.status === "complete") complete = result.update;
      else assert.equal(result.status, "pending");
    }
    assert.ok(complete);
    Y.applyUpdate(receiver.doc, complete, "remote");
    assert.ok(deepEqual(receiver.read(), big));
  });

  it("rejects out-of-order, oversized and malformed chunks", () => {
    const update = new Uint8Array(MAX_UPDATE_CHUNK_BYTES * 2 + 10).fill(7);
    const frames = splitUpdate(update, () => "id");
    assert.equal(frames.length, 3);
    const assembler = new UpdateAssembler(update.length);
    assert.equal(assembler.push("s", frames[1]).status, "error");
    assert.equal(assembler.push("s", frames[0]).status, "pending");
    assert.deepEqual(assembler.push("s", frames[2]), { status: "error", reason: "out-of-order" });

    const small = new UpdateAssembler(MAX_UPDATE_CHUNK_BYTES * 2);
    // Three chunks cannot fit under a two-chunk ceiling, so the header alone is refused.
    assert.deepEqual(small.push("s", frames[0]), { status: "error", reason: "malformed" });
    assert.deepEqual(small.push("s", { update: encodeBase64(update) }), {
      status: "error",
      reason: "too-large",
    });
    // Empty or short non-final chunks cannot pin memory with a huge count.
    assert.deepEqual(small.push("s", { update: "", chunk: { id: "x", index: 0, count: 2 } }), {
      status: "error",
      reason: "malformed",
    });
    assert.deepEqual(small.push("s", { update: "AAAA", chunk: { id: "x", index: 0, count: 2 } }), {
      status: "error",
      reason: "malformed",
    });
    assert.deepEqual(small.push("s", { update: "", chunk: { id: "x", index: 0, count: 1 } }), {
      status: "error",
      reason: "malformed",
    });
    assert.deepEqual(small.push("s", { update: "%%%%" }), { status: "error", reason: "malformed" });
    assert.deepEqual(small.push("s", { update: "AAAA", chunk: { id: "", index: 0, count: 1 } }), {
      status: "error",
      reason: "malformed",
    });
    // A real update is never empty.
    assert.deepEqual(new UpdateAssembler(10).push("s", { update: "" }), {
      status: "error",
      reason: "malformed",
    });
    // A new update while another is half received is refused.
    const overlap = new UpdateAssembler(update.length);
    assert.equal(overlap.push("s", frames[0]).status, "pending");
    assert.deepEqual(overlap.push("s", { update: "AAAA" }), {
      status: "error",
      reason: "out-of-order",
    });
    assert.equal(overlap.push("s", frames[0]).status, "pending");
    assert.deepEqual(
      overlap.push("s", { ...frames[0], chunk: { ...frames[0].chunk!, id: "other" } }),
      {
        status: "error",
        reason: "out-of-order",
      },
    );
    // Independent senders do not interfere.
    const shared = new UpdateAssembler(update.length);
    shared.push("one", frames[0]);
    shared.push("two", frames[0]);
    shared.push("one", frames[1]);
    shared.push("two", frames[1]);
    assert.equal(shared.push("one", frames[2]).status, "complete");
  });
});
