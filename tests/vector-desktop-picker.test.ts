import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addPickedVectorFiles,
  type VectorDataSink,
} from "../packages/plugins/src/plugins/maplibre-vector";
import type { GeoLibrePickedVectorFile } from "../packages/plugins/src/types";

function createSink() {
  const calls: Array<{ name: string; companionFiles?: string[] }> = [];
  const sink = {
    addData: async (
      source: File,
      options?: { companionFiles?: File[] },
    ) => {
      calls.push({
        name: source.name,
        companionFiles: options?.companionFiles?.map((file) => file.name),
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
        companionFiles: [
          new File(["shx"], "cities.shx"),
          new File(["dbf"], "cities.dbf"),
        ],
      },
    ];

    await addPickedVectorFiles(sink, picked);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "cities.shp");
    assert.deepEqual(calls[0].companionFiles, ["cities.shx", "cities.dbf"]);
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

  it("loads nothing when the dialog was cancelled (null)", async () => {
    const { sink, calls } = createSink();

    await addPickedVectorFiles(sink, null);

    assert.equal(calls.length, 0);
  });
});
