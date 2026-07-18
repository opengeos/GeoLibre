import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addPickedVectorFiles,
  type VectorDataSink,
} from "../packages/plugins/src/plugins/maplibre-vector";
import type { GeoLibrePickedVectorFile } from "../packages/plugins/src/types";

function createSink() {
  const calls: Array<{
    name: string;
    companionFiles?: string[];
    layerName?: string;
    sourcePath?: string;
    text?: string;
  }> = [];
  const sink = {
    addData: async (
      source: File,
      options?: { companionFiles?: File[]; name?: string; sourcePath?: string },
    ) => {
      calls.push({
        name: source.name,
        companionFiles: options?.companionFiles?.map((file) => file.name),
        layerName: options?.name,
        sourcePath: options?.sourcePath,
        text: await source.text(),
      });
      return {} as never;
    },
  } as unknown as VectorDataSink;
  return { sink, calls };
}

describe("addPickedVectorFiles", () => {
  it("passes a shapefile's sidecars as companionFiles", async () => {
    const { sink, calls } = createSink();
    const picked: GeoLibrePickedVectorFile[] = [
      {
        file: new File(["shp"], "cities.shp"),
        companionFiles: [new File(["shx"], "cities.shx"), new File(["dbf"], "cities.dbf")],
        sourcePath: "/data/cities.shp",
      },
    ];

    await addPickedVectorFiles(sink, picked);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "cities.shp");
    assert.deepEqual(calls[0].companionFiles, ["cities.shx", "cities.dbf"]);
    assert.equal(calls[0].sourcePath, "/data/cities.shp");
  });

  it("omits companionFiles for non-shapefile picks", async () => {
    const { sink, calls } = createSink();

    await addPickedVectorFiles(sink, [
      { file: new File(["x"], "a.geojson"), companionFiles: [] },
      { file: new File(["x"], "b.parquet"), companionFiles: [] },
    ]);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].companionFiles, undefined);
    assert.equal(calls[1].companionFiles, undefined);
  });

  it("loads native DuckDB results as GeoJSON while preserving sourcePath", async () => {
    const { sink, calls } = createSink();

    await addPickedVectorFiles(sink, [
      {
        file: new File(["parquet"], "places.parquet"),
        companionFiles: [new File(["dbf"], "places.dbf")],
        sourcePath: "/data/places.parquet",
        nativeData: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { id: 1 },
              geometry: { type: "Point", coordinates: [0, 1] },
            },
          ],
        },
      },
    ]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "places.geojson");
    assert.equal(calls[0].layerName, "places.parquet");
    assert.equal(calls[0].sourcePath, "/data/places.parquet");
    assert.equal(calls[0].companionFiles, undefined);
    assert.match(calls[0].text ?? "", /"FeatureCollection"/);
  });

  it("loads nothing when the dialog was cancelled (empty list)", async () => {
    const { sink, calls } = createSink();

    await addPickedVectorFiles(sink, []);

    assert.equal(calls.length, 0);
  });
});
