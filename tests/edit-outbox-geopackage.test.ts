import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import { VectorWriteRejectedError, type WriteVectorToSourceRequest } from "@geolibre/processing";
import type { Feature, FeatureCollection } from "geojson";
import {
  applyConflictResolutions,
  syncOutboxEntry,
  type OutboxEntry,
} from "../apps/geolibre-desktop/src/lib/edit-sync/edit-outbox";
import {
  buildGeoPackageChangeSet,
  captureGeoPackageBaseline,
  createGeoPackageSyncAdapter,
  geoPackageBaseline,
  geopackageOutboxId,
  geopackageOutboxTarget,
  isGeoPackagePath,
  pruneGeoPackageBaselines,
  reconcileGeoPackageLayerAfterSync,
  resetGeoPackageBaselines,
  sha256Hex,
  withGeoPackageLocalIds,
} from "../apps/geolibre-desktop/src/lib/edit-sync/geopackage-edit-sync";
import { restoreFeatureIds } from "../apps/geolibre-desktop/src/lib/gpkg-reader";

const PATH = "/data/field/wells.gpkg";

function well(fid: number | string | undefined, status: string, x = Number(fid) || 0): Feature {
  return {
    type: "Feature",
    ...(fid === undefined ? {} : { id: fid }),
    geometry: { type: "Point", coordinates: [x, 1] },
    properties: { name: `well ${fid}`, status },
  };
}

/**
 * A fake GeoPackage on disk: the "file" is its JSON-encoded rows, read and
 * parsed like the real reader (row id as feature id), written like the
 * sidecar with preserve_fids and the expected-hash check.
 */
class FakeFile {
  rows = new Map<number, Feature>();
  writes: WriteVectorToSourceRequest[] = [];
  unreachable = false;
  loseAnswer = false;

  bytes(): Uint8Array<ArrayBuffer> {
    const text = JSON.stringify([...this.rows.values()]);
    return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  }

  deps() {
    return {
      readFile: async () => {
        if (this.unreachable)
          throw new Error("No such file or directory (the drive is not mounted)");
        return this.bytes();
      },
      parse: async (bytes: Uint8Array<ArrayBuffer>): Promise<FeatureCollection> => ({
        type: "FeatureCollection",
        features: JSON.parse(new TextDecoder().decode(bytes)),
      }),
      write: async (request: WriteVectorToSourceRequest) => {
        this.writes.push(structuredClone(request));
        const current = createHash("sha256").update(this.bytes()).digest("hex");
        if (request.expected_sha256 !== current) {
          throw new VectorWriteRejectedError("wells.gpkg changed since it was read.", 409);
        }
        assert.equal(request.preserve_fids, true);
        this.rows = new Map(
          request.geojson.features.map((f) => [f.id as number, structuredClone(f)]),
        );
        if (this.loseAnswer) {
          this.loseAnswer = false;
          throw new Error("Could not connect to the GeoLibre sidecar");
        }
        return {};
      },
      sha256: sha256Hex,
    };
  }
}

function seed(): { file: FakeFile; layer: GeoLibreLayer } {
  const file = new FakeFile();
  for (let fid = 1; fid <= 3; fid++) file.rows.set(fid, well(fid, "ok"));
  const layer = {
    id: "wells",
    name: "Wells",
    type: "geojson",
    sourcePath: PATH,
    geojson: {
      type: "FeatureCollection",
      features: [...file.rows.values()].map((f) => structuredClone(f)),
    },
    metadata: {},
  } as unknown as GeoLibreLayer;
  assert.ok(captureGeoPackageBaseline(layer));
  return { file, layer };
}

function edited(layer: GeoLibreLayer, features: Feature[]): GeoLibreLayer {
  return {
    ...layer,
    geojson: withGeoPackageLocalIds({ type: "FeatureCollection", features }),
    metadata: { geometryEdited: true },
  };
}

function entryFor(layer: GeoLibreLayer): OutboxEntry {
  const target = geopackageOutboxTarget(layer)!;
  return {
    id: geopackageOutboxId(target, layer.id),
    backend: "geopackage",
    target,
    targetLabel: PATH,
    layerId: layer.id,
    layerName: layer.name,
    ops: buildGeoPackageChangeSet(layer)!,
    status: "pending",
    conflicts: [],
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

afterEach(() => resetGeoPackageBaselines());

describe("GeoPackage bases", () => {
  it("records a base only for an unedited layer whose rows carry ids", () => {
    const { layer } = seed();
    assert.equal(geoPackageBaseline(layer)!.size, 3);
    resetGeoPackageBaselines();
    assert.equal(
      captureGeoPackageBaseline({ ...layer, metadata: { geometryEdited: true } }),
      false,
    );
    const noIds = {
      ...layer,
      geojson: { type: "FeatureCollection", features: [well(undefined, "x")] },
    } as GeoLibreLayer;
    assert.equal(captureGeoPackageBaseline(noIds), false);
    assert.equal(captureGeoPackageBaseline({ ...layer, sourcePath: "/x.geojson" }), false);
    assert.equal(geoPackageBaseline({ ...layer, sourcePath: "/other.gpkg" }), undefined);
    assert.ok(isGeoPackagePath(" A.GPKG "));
    captureGeoPackageBaseline(layer);
    pruneGeoPackageBaselines([]);
    assert.equal(geoPackageBaseline(layer), undefined);
  });

  it("carries row ids across reprojection when the order is intact", () => {
    const source: FeatureCollection = {
      type: "FeatureCollection",
      features: [well(4, "a"), well(9, "b")],
    };
    const reprojected: FeatureCollection = {
      type: "FeatureCollection",
      features: [well(undefined, "a", 10), well(undefined, "b", 20)],
    };
    assert.deepEqual(
      restoreFeatureIds(source, reprojected).features.map((f) => f.id),
      [4, 9],
    );
    const short = { type: "FeatureCollection" as const, features: [well(undefined, "a")] };
    assert.equal(restoreFeatureIds(source, short), short);
  });
});

describe("GeoPackage sync adapter", () => {
  it("writes the file's rows with the settled edits, keeping row ids", async () => {
    const { file, layer } = seed();
    const next = edited(layer, [well(1, "capped"), well(2, "ok"), well(undefined, "new", 7)]);
    const entry = entryFor(next);
    // Another program added row 4 meanwhile; it must survive the save.
    file.rows.set(4, well(4, "theirs"));
    const outcome = await syncOutboxEntry(entry, createGeoPackageSyncAdapter(entry, file.deps()));
    assert.equal(outcome.kind, "synced");
    assert.deepEqual(
      [...file.rows.keys()].sort((a, b) => a - b),
      [1, 2, 4, 5],
    );
    assert.equal(file.rows.get(1)!.properties!.status, "capped");
    assert.equal(file.rows.get(5)!.properties!.status, "new");
    assert.equal([...outcome.insertedKeys.values()][0], "5");
  });

  it("holds a row another program changed as a conflict", async () => {
    const { file, layer } = seed();
    const next = edited(layer, [well(1, "mine"), well(2, "mine too"), well(3, "ok")]);
    const entry = entryFor(next);
    file.rows.set(1, well(1, "theirs"));
    const adapter = createGeoPackageSyncAdapter(entry, file.deps());
    const first = await syncOutboxEntry(entry, adapter);
    assert.equal(first.kind, "conflict");
    assert.equal(file.rows.get(1)!.properties!.status, "theirs");
    assert.equal(file.rows.get(2)!.properties!.status, "mine too");
    const resolved = applyConflictResolutions(
      first.entry!,
      new Map([[first.entry!.ops[0].id, "mine" as const]]),
    );
    const second = await syncOutboxEntry(resolved, adapter);
    assert.equal(second.kind, "synced");
    assert.equal(file.rows.get(1)!.properties!.status, "mine");
  });

  it("re-reads when the file changes between the read and the write", async () => {
    const { file, layer } = seed();
    const entry = entryFor(edited(layer, [well(1, "mine"), well(2, "ok"), well(3, "ok")]));
    const deps = file.deps();
    const write = deps.write;
    let raced = false;
    deps.write = async (request) => {
      if (!raced) {
        raced = true;
        file.rows.set(1, well(1, "saved by QGIS"));
      }
      return write(request);
    };
    const outcome = await syncOutboxEntry(entry, createGeoPackageSyncAdapter(entry, deps));
    assert.equal(outcome.kind, "conflict");
    assert.equal(file.rows.get(1)!.properties!.status, "saved by QGIS");
  });

  it("waits for an unreachable file and dedupes an insert whose answer was lost", async () => {
    const { file, layer } = seed();
    const entry = entryFor(
      edited(layer, [well(1, "ok"), well(2, "ok"), well(3, "ok"), well(undefined, "drawn", 8)]),
    );
    const adapter = createGeoPackageSyncAdapter(entry, file.deps());
    file.unreachable = true;
    const away = await syncOutboxEntry(entry, adapter);
    assert.equal(away.kind, "offline");
    assert.equal(away.entry!.lastErrorCode, "geopackageUnreachable");
    file.unreachable = false;
    file.loseAnswer = true;
    const lost = await syncOutboxEntry(away.entry!, adapter);
    assert.equal(lost.kind, "offline");
    assert.equal(file.rows.size, 4);
    const retry = await syncOutboxEntry(lost.entry!, adapter);
    assert.equal(retry.kind, "synced");
    assert.equal(file.rows.size, 4, "the insert must not land twice");
    assert.equal(retry.insertedKeys.size, 1);
  });

  it("refuses to empty the layer and reports other write refusals", async () => {
    const { file, layer } = seed();
    const entry = entryFor(edited(layer, []));
    const emptied = await syncOutboxEntry(entry, createGeoPackageSyncAdapter(entry, file.deps()));
    assert.equal(emptied.kind, "error");
    assert.equal(emptied.entry!.lastErrorCode, "geopackageEmpty");
    const deps = file.deps();
    deps.write = async () => {
      throw new VectorWriteRejectedError("Path is outside the allowed roots", 403);
    };
    const one = entryFor(edited(layer, [well(1, "x"), well(2, "ok"), well(3, "ok")]));
    const refused = await syncOutboxEntry(one, createGeoPackageSyncAdapter(one, deps));
    assert.equal(refused.kind, "error");
  });
});

describe("reconcileGeoPackageLayerAfterSync", () => {
  it("stamps row ids, applies kept-theirs rows, and re-bases settled rows", async () => {
    const { file, layer } = seed();
    let live = edited(layer, [
      well(1, "mine"),
      well(2, "fixed"),
      well(3, "ok"),
      well(undefined, "new", 7),
    ]);
    const entry = entryFor(live);
    file.rows.set(1, well(1, "theirs"));
    const adapter = createGeoPackageSyncAdapter(entry, file.deps());
    const deps = {
      getLayer: () => live,
      updateLayer: (_id: string, patch: Partial<GeoLibreLayer>) => {
        live = { ...live, ...patch } as GeoLibreLayer;
      },
    };
    const first = await syncOutboxEntry(entry, adapter);
    assert.ok(reconcileGeoPackageLayerAfterSync(entry, first, deps));
    assert.equal(live.metadata.geometryEdited, true, "a conflict is still pending");
    const resolved = applyConflictResolutions(
      first.entry!,
      new Map([[first.entry!.ops[0].id, "theirs" as const]]),
    );
    const second = await syncOutboxEntry(resolved, adapter);
    reconcileGeoPackageLayerAfterSync(resolved, second, deps);
    const byId = new Map(live.geojson!.features.map((f) => [f.id, f.properties!.status]));
    assert.equal(byId.get(1), "theirs");
    assert.equal(byId.get(4), "new");
    assert.equal(live.metadata.geometryEdited, undefined);
    assert.deepEqual(buildGeoPackageChangeSet(live), [], "nothing left to save");
  });
});
